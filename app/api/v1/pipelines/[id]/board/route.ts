/**
 * GET /api/v1/pipelines/[id]/board
 *
 * Returns the full board snapshot for the Kanban: pipeline metadata + active
 * stages (ordered by position) + open leads (excluding archived). All RLS-
 * filtered to the caller's org via cookie session.
 *
 * Why this exists: previously useBoard hit supabase-js directly from the
 * browser. The auth cookie is httpOnly, which the browser Supabase client
 * cannot read — auth.uid() came back null and RLS dropped the pipeline row,
 * surfacing as PostgREST "Cannot coerce result to a single JSON object"
 * (PGRST116). Routing through the API ensures the server-side cookie reader
 * runs, same as every other authed query.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  roteiaProximasAcoes,
  type EstadoDoContato,
  type PropostaAmbigua,
} from "@/lib/leads/next-action";
import type { LeadCandidate } from "@/lib/leads/active-lead";
import { proximasReunioesPorLead, type AtividadeDeReuniao } from "@/lib/leads/next-meeting";
import { createClient } from "@/lib/supabase/server";
import type { BoardData, Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * Anexa a identidade do agente dono (nome + versão publicada) aos leads que têm
 * `owner_kind='ai'`.
 *
 * **Sem filtro de `is_active`/`archived_at` de propósito.** Quem é o dono é
 * pergunta de EXIBIÇÃO e vale para qualquer agente: desativar um bot não pode
 * transformar os negócios dele em cards anônimos. A lista de agentes que PODEM
 * receber um lead (o picker, `/api/v1/ai/agents/assignable`) é outra pergunta e
 * lá os filtros estão certos.
 *
 * `organization_id` é filtrado explicitamente — vem do pipeline já validado pela
 * RLS do caller, nunca do body.
 */
async function withOwnerAgents(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  const agentIds = [
    ...new Set(
      leads
        .filter((l) => l.owner_kind === "ai" && l.owner_agent_id)
        .map((l) => l.owner_agent_id as string),
    ),
  ];
  if (agentIds.length === 0) return { leads, error: null };

  const { data: agents, error: agentsErr } = await supabase
    .from("ai_agents")
    .select("id, name, published_version_id")
    .eq("organization_id", organizationId)
    .in("id", agentIds);
  if (agentsErr) return { leads, error: agentsErr.message };

  const agentRows = (agents ?? []) as Array<{
    id: string;
    name: string;
    published_version_id: string | null;
  }>;

  const publishedIds = agentRows
    .map((a) => a.published_version_id)
    .filter((v): v is string => !!v);
  const versionById = new Map<string, number>();
  if (publishedIds.length > 0) {
    const { data: versions, error: versionsErr } = await supabase
      .from("ai_agent_versions")
      .select("id, version_number")
      .eq("organization_id", organizationId)
      .in("id", publishedIds);
    if (versionsErr) return { leads, error: versionsErr.message };
    for (const v of (versions ?? []) as Array<{ id: string; version_number: number }>) {
      versionById.set(v.id, v.version_number);
    }
  }

  const byId = new Map(agentRows.map((a) => [a.id, a]));
  return {
    leads: leads.map((lead) => {
      if (lead.owner_kind !== "ai" || !lead.owner_agent_id) return lead;
      const agent = byId.get(lead.owner_agent_id);
      if (!agent) return lead;
      return {
        ...lead,
        owner_agent: {
          id: agent.id,
          name: agent.name,
          version_number: agent.published_version_id
            ? (versionById.get(agent.published_version_id) ?? null)
            : null,
        },
      };
    }),
    error: null,
  };
}

/**
 * Anexa a próxima ação proposta pelo agente aos leads que a receberam.
 *
 * Os candidatos são buscados por CONTATO na org inteira, e não só neste
 * pipeline: `resolveActiveLeadForContact` precisa enxergar todos os negócios
 * abertos da pessoa para poder chamar de ambíguo o que é ambíguo. Recortando a
 * lista por pipeline, dois negócios ambíguos em boards diferentes apareceriam
 * como um único negócio em cada board, e os dois exibiriam a mesma proposta.
 */
/**
 * Abre um item de caixa por proposta sem dono — no máximo um por contato.
 *
 * Deduplicado por (kind, ref_id, status='open') porque o board é lido a cada
 * refresh: sem isto, um contato ambíguo produziria um item por render até a
 * caixa virar ruído e ninguém mais olhar.
 *
 * Falha aqui NÃO derruba o board: o aviso é importante, mas menos que a tela
 * abrir. O erro sobe para o Sentry pelo caminho normal de exceção não tratada
 * do handler — o que não pode é o usuário perder o board por causa do aviso.
 */
async function avisaAmbiguas(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  ambiguas: PropostaAmbigua[],
): Promise<void> {
  if (ambiguas.length === 0) return;

  const { data: jaAbertos } = await supabase
    .from("agent_inbox_items")
    .select("ref_id")
    .eq("organization_id", organizationId)
    .eq("kind", "next_action_ambiguous")
    .eq("status", "open")
    .in(
      "ref_id",
      ambiguas.map((a) => a.contact_id),
    );
  const abertos = new Set(
    ((jaAbertos ?? []) as Array<{ ref_id: string }>).map((r) => r.ref_id),
  );

  const novos = ambiguas
    .filter((a) => !abertos.has(a.contact_id))
    .map((a) => ({
      organization_id: organizationId,
      kind: "next_action_ambiguous",
      severity: "warn",
      title: `A IA propôs uma próxima ação, mas o contato tem ${a.candidateIds.length} negócios abertos`,
      body: `Proposta: "${a.texto}". Escolha a qual negócio ela pertence — o sistema não adivinha para não executar no negócio errado.`,
      ref_kind: "contact",
      ref_id: a.contact_id,
      status: "open",
    }));
  if (novos.length === 0) return;

  await supabase.from("agent_inbox_items").insert(novos);
}

/**
 * Anexa o score aos leads que o têm — LEFT JOIN, nunca INNER.
 *
 * Score ausente é estado legítimo (sinal insuficiente, cenário 17). Um INNER
 * apagaria do quadro justamente os leads sem sinal, que são os que mais
 * precisam de atenção humana — o oposto do que o produto existe para fazer.
 *
 * A faixa vem PERSISTIDA e é entregue como está: recalculá-la aqui (ou na UI)
 * ignoraria a histerese e devolveria o card piscando na fronteira, no único
 * lugar onde o CHECK de coerência não alcança.
 */
async function withScores(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  if (leads.length === 0) return { leads, error: null };

  const { data, error } = await supabase
    .from("crm_lead_scores")
    .select(
      "lead_id, ai_probability, ai_probability_reason, ai_probability_band, ai_probability_evidence, ai_probability_at",
    )
    .eq("organization_id", organizationId)
    .in(
      "lead_id",
      leads.map((l) => l.id),
    );
  if (error) return { leads, error: error.message };

  const porLead = new Map<string, NonNullable<Lead["score"]>>();
  for (const row of (data ?? []) as Array<{
    lead_id: string;
    ai_probability: number | string | null;
    ai_probability_reason: string | null;
    ai_probability_band: string | null;
    ai_probability_evidence: { factors?: unknown } | null;
    ai_probability_at: string | null;
  }>) {
    // `numeric` chega como string no supabase-js; `null` continua null — e a
    // diferença entre null e 0 é justamente o que não pode se perder aqui.
    if (row.ai_probability === null || row.ai_probability_band === null) continue;
    const factors = Array.isArray(row.ai_probability_evidence?.factors)
      ? (row.ai_probability_evidence.factors as NonNullable<Lead["score"]>["factors"])
      : [];
    porLead.set(row.lead_id, {
      probability: Number(row.ai_probability),
      reason: row.ai_probability_reason ?? "",
      band: row.ai_probability_band as NonNullable<Lead["score"]>["band"],
      factors,
      at: row.ai_probability_at,
    });
  }

  return {
    leads: leads.map((lead) => {
      const score = porLead.get(lead.id);
      return score ? { ...lead, score } : lead;
    }),
    error: null,
  };
}

/**
 * Anexa a conversa mais recente do contato — o atalho do quadro para o inbox.
 *
 * LEFT, como o score: lead sem contato (criado à mão, vindo de webhook) e
 * contato sem conversa são estados normais, e sumir com esses cards do quadro
 * seria esconder justamente os que ninguém atendeu ainda.
 *
 * A MAIS RECENTE por contato, não todas: o card mostra uma linha, e escolher na
 * UI exigiria trazer o histórico inteiro de cada lead para descartar quase tudo.
 *
 * Ordena por `last_message_at` e fica com a primeira de cada contato — as
 * conversas já vêm ordenadas, então o primeiro visto é o mais recente.
 */
async function withConversas(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];
  if (contactIds.length === 0) return { leads, error: null };

  const { data, error } = await supabase
    .from("conversations")
    .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return { leads, error: error.message };

  const porContato = new Map<string, NonNullable<Lead["conversa"]>>();
  for (const row of (data ?? []) as Array<{
    id: string;
    contact_id: string;
    last_message_preview: string | null;
    last_message_at: string | null;
    unread_count_for_assignee: number | null;
  }>) {
    // Primeira vista vence: a consulta já veio ordenada por atividade.
    if (porContato.has(row.contact_id)) continue;
    porContato.set(row.contact_id, {
      id: row.id,
      preview: row.last_message_preview,
      last_message_at: row.last_message_at,
      unread: row.unread_count_for_assignee ?? 0,
    });
  }

  return {
    leads: leads.map((lead) => {
      const conversa = lead.contact_id ? porContato.get(lead.contact_id) : undefined;
      return conversa ? { ...lead, conversa } : lead;
    }),
    error: null,
  };
}

/**
 * Anexa a data/hora da PRÓXIMA visita/reunião agendada — só enquanto pendente.
 *
 * Mesmo padrão de `withConversas` (LEFT, "primeira vista vence" na ordenação
 * por mais recente): `crm_lead_activities` não tem `status`, então "ainda
 * pendente" é inferido pela ORDEM — `meeting_scheduled`/`meeting_outcome`
 * são dois tipos no MESMO fluxo (reagendar é emitir de novo, registrar
 * presença é emitir depois), e o evento mais recente de qualquer um dos dois
 * dá a resposta: se for `meeting_outcome`, o agendamento mais novo já foi
 * resolvido — não há visita pendente pra mostrar no card.
 */
async function withNextMeetings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  if (leads.length === 0) return { leads, error: null };

  const { data, error } = await supabase
    .from("crm_lead_activities")
    .select("lead_id, type, payload")
    .eq("organization_id", organizationId)
    .in("type", ["meeting_scheduled", "meeting_outcome"])
    .in(
      "lead_id",
      leads.map((l) => l.id),
    )
    .order("performed_at", { ascending: false });
  if (error) return { leads, error: error.message };

  const porLead = proximasReunioesPorLead((data ?? []) as AtividadeDeReuniao[]);

  return {
    leads: leads.map((lead) => {
      const nextMeetingAt = porLead.get(lead.id);
      return nextMeetingAt ? { ...lead, next_meeting_at: nextMeetingAt } : lead;
    }),
    error: null,
  };
}

async function withNextActions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
  defaultPipelineId: string | null,
): Promise<{ leads: Lead[]; error: string | null }> {
  const contactIds = [
    ...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c)),
  ];
  if (contactIds.length === 0) return { leads, error: null };

  const [{ data: estados, error: estadosErr }, { data: candidatos, error: candErr }] =
    await Promise.all([
      supabase
        .from("lead_state")
        .select("contact_id, next_action, next_action_seq, updated_at")
        .eq("organization_id", organizationId)
        .in("contact_id", contactIds)
        .not("next_action", "is", null),
      supabase
        .from("crm_leads")
        .select(
          "id, organization_id, pipeline_id, status, last_activity_at, created_at, contact_id",
        )
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .in("contact_id", contactIds),
    ]);
  if (estadosErr) return { leads, error: estadosErr.message };
  if (candErr) return { leads, error: candErr.message };
  if (!estados || estados.length === 0) return { leads, error: null };

  const { porLead, ambiguas } = roteiaProximasAcoes(
    estados as EstadoDoContato[],
    (candidatos ?? []) as Array<LeadCandidate & { contact_id: string | null }>,
    { defaultPipelineId },
  );

  // Recusar o palpite não pode virar silêncio: a proposta que não achou dono vai
  // para a caixa, onde um humano desambigua. Escrever a partir de um GET não é
  // bonito, e é deliberado — a ambiguidade só EXISTE quando se olha o conjunto
  // de negócios abertos AGORA, e é aqui que esse olhar acontece. Fazer no
  // momento da escrita da proposta perderia o caso em que o segundo negócio
  // nasce depois dela.
  await avisaAmbiguas(supabase, organizationId, ambiguas);

  if (porLead.size === 0) return { leads, error: null };

  return {
    leads: leads.map((lead) => {
      const acao = porLead.get(lead.id);
      return acao ? { ...lead, next_action: acao } : lead;
    }),
    error: null,
  };
}

/**
 * Funde o resultado das 5 enriquecedoras (rodadas em paralelo contra a MESMA
 * `base`) de volta numa lista só, por id de lead.
 *
 * Pura e exportada de propósito — é o pedaço que prova que paralelizar não
 * mudou o resultado final, sem precisar montar um Supabase de mentira pra
 * testar. `!== undefined` replica o `valor ? {...lead, campo: valor} : lead`
 * que cada enriquecedora já fazia: nenhum dos 5 campos é um valor "falso mas
 * presente" (todos são objeto/string quando existem), então as duas checagens
 * sempre concordam — só a de `undefined` dá pra fazer sem reimportar a
 * lógica de cada enriquecedora aqui.
 */
export function mesclaEnriquecimentos(
  base: Lead[],
  enriquecidos: {
    owner: Lead[];
    score: Lead[];
    conversa: Lead[];
    reuniao: Lead[];
    acao: Lead[];
  },
): Lead[] {
  const ownerById = new Map(enriquecidos.owner.map((l) => [l.id, l.owner_agent]));
  const scoreById = new Map(enriquecidos.score.map((l) => [l.id, l.score]));
  const conversaById = new Map(enriquecidos.conversa.map((l) => [l.id, l.conversa]));
  const reuniaoById = new Map(enriquecidos.reuniao.map((l) => [l.id, l.next_meeting_at]));
  const acaoById = new Map(enriquecidos.acao.map((l) => [l.id, l.next_action]));

  return base.map((lead) => ({
    ...lead,
    ...(ownerById.get(lead.id) !== undefined ? { owner_agent: ownerById.get(lead.id) } : {}),
    ...(scoreById.get(lead.id) !== undefined ? { score: scoreById.get(lead.id) } : {}),
    ...(conversaById.get(lead.id) !== undefined ? { conversa: conversaById.get(lead.id) } : {}),
    ...(reuniaoById.get(lead.id) !== undefined ? { next_meeting_at: reuniaoById.get(lead.id) } : {}),
    ...(acaoById.get(lead.id) !== undefined ? { next_action: acaoById.get(lead.id) } : {}),
  }));
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const [
    { data: pipeline, error: pipelineErr },
    { data: stages, error: stagesErr },
    { data: leads, error: leadsErr },
  ] = await Promise.all([
    supabase.from("crm_pipelines").select("*").eq("id", pipelineId).maybeSingle(),
    supabase
      .from("crm_stages")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("crm_leads")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      // "Cliente já existente" (Fase 4) sai do board de vez, diferente de
      // won/lost — que continuam visíveis na coluna terminal do funil. Não é
      // aquisição nova nem demanda pra acompanhar aqui; a conversa segue
      // normal no Inbox, só o card some.
      .neq("status", "existing_customer")
      .order("position_in_stage"),
  ]);

  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });
  if (leadsErr) return fail("internal_error", leadsErr.message, 500, { requestId });
  if (!pipeline) return fail("resource_not_found", "Pipeline não encontrado.", 404, { requestId });

  // As 5 enriquecidas abaixo são independentes entre si — cada uma só lê
  // campos da linha ORIGINAL do lead (id/contact_id/owner_kind/...) e só
  // ACRESCENTA seu próprio campo (owner_agent/score/conversa/next_meeting_at),
  // nunca lê o que outra escreveu. Rodavam em cadeia (6 round trips
  // sequenciais) sem necessidade — medido como o maior ganho de latência
  // disponível no carregamento do quadro sem mexer em schema nem em índice.
  // A exceção é `withNextActions`, que precisa do pipeline padrão da org
  // ANTES de rodar — essa consulta entra no MESMO Promise.all (ela também
  // não depende de nenhuma das outras 4), e só `withNextActions` em si fica
  // de fato sequencial, depois do grupo.
  const orgId = (pipeline as Pipeline).organization_id;
  const baseLeads = (leads ?? []) as Lead[];

  const [
    { data: pipelinePadrao },
    leadsWithOwner,
    leadsComScore,
    leadsComConversa,
    leadsComReuniao,
  ] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_default", true)
      .maybeSingle(),
    withOwnerAgents(supabase, orgId, baseLeads),
    withScores(supabase, orgId, baseLeads),
    withConversas(supabase, orgId, baseLeads),
    withNextMeetings(supabase, orgId, baseLeads),
  ]);
  if (leadsWithOwner.error) return fail("internal_error", leadsWithOwner.error, 500, { requestId });
  if (leadsComScore.error) return fail("internal_error", leadsComScore.error, 500, { requestId });
  if (leadsComConversa.error) return fail("internal_error", leadsComConversa.error, 500, { requestId });
  if (leadsComReuniao.error) return fail("internal_error", leadsComReuniao.error, 500, { requestId });

  const leadsComAcao = await withNextActions(
    supabase,
    orgId,
    baseLeads,
    (pipelinePadrao as { id: string } | null)?.id ?? null,
  );
  if (leadsComAcao.error) {
    return fail("internal_error", leadsComAcao.error, 500, { requestId });
  }

  const leadsEnriquecidos = mesclaEnriquecimentos(baseLeads, {
    owner: leadsWithOwner.leads,
    score: leadsComScore.leads,
    conversa: leadsComConversa.leads,
    reuniao: leadsComReuniao.leads,
    acao: leadsComAcao.leads,
  });

  const board: BoardData = {
    pipeline: pipeline as Pipeline,
    stages: (stages ?? []) as Stage[],
    leads: leadsEnriquecidos,
  };

  return ok(board, { requestId });
}
