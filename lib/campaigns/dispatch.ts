/**
 * Um TICK do despachante de campanhas — chamado pelo cron
 * `api/v1/cron/campaign-dispatch` a cada minuto. Processa um lote pequeno
 * por campanha `queued`/`running`, respeitando janela de horário, limite
 * diário e o ritmo da campanha (`lib/campaigns/velocidade.ts`) — TUDO reaproveitado de
 * `lib/automation/throttle.ts`, nada novo em anti-banimento.
 *
 * Nenhum código aqui fala com a Graph API: `ensureConversation` +
 * `sendMessageHandler` são o MESMO caminho que `JanelaFechadaAviso.tsx` usa
 * pro envio manual de um template só. As duas funções entram por parâmetro
 * (`DispatchDeps`) pra o teste poder trocá-las por dublê sem bater na Meta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation } from "@/lib/automation/start-conversation";
import { checkDailyLimit, withinSendWindow } from "@/lib/automation/throttle";
import { pausarSeCobrancaRecusada } from "@/lib/campaigns/cobranca-recusada";
import { FALHAS_SEGUIDAS_PARA_FREAR, RITMOS, ritmoDe, VELOCIDADE_PADRAO } from "@/lib/campaigns/velocidade";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { motivoDaFalha } from "@/lib/messaging/motivo-da-falha";
import { renderBodyWithValues } from "@/lib/messaging/render-body";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

/** Deixa margem sob o timeout do cron (25s, `docker/scheduler/entrypoint.sh`). */
const DEFAULT_TIME_BUDGET_MS = 20_000;

/** Tamanho da página do PostgREST (`max-rows`): leitura maior que isso volta truncada. */
const PAGINA_DE_DESTINATARIOS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DispatchDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  ensureConversationFn?: typeof ensureConversation;
  sendMessageFn?: typeof sendMessageHandler;
  timeBudgetMs?: number;
}

export interface DispatchSummary {
  campaignsProcessed: number;
  sent: number;
  failed: number;
}

interface CampanhaRow {
  id: string;
  organization_id: string;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  status: string;
  name?: string | null;
  velocidade?: string | null;
}

interface DestinatarioRow {
  id: string;
  contact_id: string;
  resolved_values: Record<string, string>;
}

/**
 * Recontagem por LEITURA das linhas, não incremento — a mesma proteção que
 * `planSync` já usa noutro lugar: uma única instância de cron por vez
 * (mesma premissa que `_lastSendAt` em `send-whatsapp.ts` já assume), então
 * não há corrida a resolver, só simplicidade a ganhar.
 */
export async function atualizarContadores(admin: SupabaseClient, campaignId: string): Promise<void> {
  // O PostgREST devolve no máximo 1.000 linhas por consulta: lido de uma vez, uma campanha
  // maior contava só as mil primeiras (que são as ainda não enviadas, porque a linha
  // atualizada muda de lugar) — contador em 0 e, pior, `completed` antes da hora.
  // `order("id")` dá às páginas uma ordem estável.
  const linhas: Array<{ status: string }> = [];
  for (let de = 0; ; de += PAGINA_DE_DESTINATARIOS) {
    const { data, error } = await admin
      .from("whatsapp_campaign_recipients")
      .select("status")
      .eq("campaign_id", campaignId)
      .order("id", { ascending: true })
      .range(de, de + PAGINA_DE_DESTINATARIOS - 1);
    // Sem leitura confiável não se atualiza nada: gravar `completed` por uma contagem
    // parcial é pior do que deixar o contador desatualizado até o próximo minuto.
    if (error) return;
    const pagina = (data ?? []) as Array<{ status: string }>;
    linhas.push(...pagina);
    if (pagina.length < PAGINA_DE_DESTINATARIOS) break;
  }
  const sentCount = linhas.filter((l) => l.status === "sent").length;
  const failedCount = linhas.filter((l) => l.status === "failed").length;
  const restaAlgo = linhas.some((l) => l.status === "pending" || l.status === "sending");

  await admin
    .from("whatsapp_campaigns")
    .update({
      sent_count: sentCount,
      failed_count: failedCount,
      ...(restaAlgo ? {} : { status: "completed", completed_at: new Date().toISOString() }),
    })
    .eq("id", campaignId);
}

async function processarCampanha(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  deadline: number,
  deps: Required<Pick<DispatchDeps, "sleep" | "ensureConversationFn" | "sendMessageFn">>,
  resumo: DispatchSummary,
): Promise<void> {
  const { data: templateRow } = await admin
    .from("meta_templates")
    .select("components")
    .eq("organization_id", campanha.organization_id)
    .eq("channel_session_id", campanha.channel_session_id)
    .eq("name", campanha.template_name)
    .eq("language", campanha.template_language)
    .maybeSingle();
  const rawBody =
    lerConteudo((templateRow as { components?: unknown } | null)?.components ?? []).body ??
    campanha.template_name;

  /** Manda para UM destinatário já marcado `sending`; devolve se saiu. */
  async function enviarUm(alvo: DestinatarioRow): Promise<boolean> {
    try {
      const conversationId = await deps.ensureConversationFn(
        admin,
        campanha.organization_id,
        alvo.contact_id,
        campanha.channel_session_id,
      );
      const message = await deps.sendMessageFn(
        admin,
        {
          organization_id: campanha.organization_id,
          actor: { type: "webhook_source", id: campanha.id },
          requestId: `campaign:${campanha.id}`,
        },
        {
          conversation_id: conversationId,
          type: "template",
          template_name: campanha.template_name,
          template_language: campanha.template_language,
          template_values: alvo.resolved_values,
          body: renderBodyWithValues(rawBody, alvo.resolved_values),
        },
      );

      if (message.status === "sent") {
        await admin
          .from("whatsapp_campaign_recipients")
          .update({ status: "sent", external_id: message.external_id, sent_at: new Date().toISOString() })
          .eq("id", alvo.id);
        resumo.sent += 1;
        return true;
      }
      // `queued`/`failed` — o canal pode ter caído entre a criação da
      // campanha e este tick. Tratado como falha desta tentativa; o
      // operador vê o motivo na lista de destinatários.
      await admin
        .from("whatsapp_campaign_recipients")
        .update({
          status: "failed",
          error_message: motivoDaFalha(message),
        })
        .eq("id", alvo.id);
      resumo.failed += 1;
      return false;
    } catch (err) {
      await admin
        .from("whatsapp_campaign_recipients")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message.slice(0, 500) : "erro desconhecido",
        })
        .eq("id", alvo.id);
      resumo.failed += 1;
      return false;
    }
  }

  // Antes de mandar mais: a Meta já recusou a cobrança das últimas? Então não adianta continuar.
  if (await pausarSeCobrancaRecusada(admin, campanha)) return;

  const ritmoEscolhido = ritmoDe(campanha.velocidade);
  let falhasSeguidas = 0;

  while (Date.now() < deadline) {
    // Freio: falha em sequência (número recusado, token caído, Meta instável) desacelera para o
    // ritmo cuidadoso até a próxima rodada, em vez de martelar a Meta na velocidade escolhida.
    const ritmo = falhasSeguidas >= FALHAS_SEGUIDAS_PARA_FREAR ? RITMOS[VELOCIDADE_PADRAO] : ritmoEscolhido;

    const { data: pendentes } = await admin
      .from("whatsapp_campaign_recipients")
      .select("id, contact_id, resolved_values")
      .eq("campaign_id", campanha.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(ritmo.lote);
    const lote = (pendentes ?? []) as DestinatarioRow[];
    if (lote.length === 0) break;

    await Promise.all(
      lote.map((d) =>
        admin.from("whatsapp_campaign_recipients").update({ status: "sending" }).eq("id", d.id),
      ),
    );

    const resultados = await Promise.all(lote.map(enviarUm));
    for (const saiu of resultados) falhasSeguidas = saiu ? 0 : falhasSeguidas + 1;

    if (Date.now() >= deadline) break;
    await deps.sleep(ritmo.pausaMs);
  }

  await atualizarContadores(admin, campanha.id);
}

export async function dispatchCampaignsTick(
  admin: SupabaseClient,
  deps: DispatchDeps = {},
): Promise<DispatchSummary> {
  const now = deps.now ?? (() => new Date());
  const deadline = Date.now() + (deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const resolvedDeps = {
    sleep: deps.sleep ?? sleep,
    ensureConversationFn: deps.ensureConversationFn ?? ensureConversation,
    sendMessageFn: deps.sendMessageFn ?? sendMessageHandler,
  };

  const resumo: DispatchSummary = { campaignsProcessed: 0, sent: 0, failed: 0 };

  const { data: campanhas } = await admin
    .from("whatsapp_campaigns")
    .select("id, organization_id, channel_session_id, name, template_name, template_language, status, velocidade")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true });

  // Um número de WhatsApp é um recurso só: o espaçamento anti-banimento vale POR NÚMERO.
  // Campanhas do mesmo canal seguem em fila (mais antiga primeiro); canais diferentes não
  // têm nada a ver um com o outro e rodam ao mesmo tempo — senão a campanha de uma loja
  // esperava a das outras terminarem.
  const porCanal = new Map<string, CampanhaRow[]>();
  for (const campanha of (campanhas ?? []) as CampanhaRow[]) {
    const fila = porCanal.get(campanha.channel_session_id) ?? [];
    fila.push(campanha);
    porCanal.set(campanha.channel_session_id, fila);
  }

  await Promise.all(
    [...porCanal.values()].map(async (fila) => {
      for (const campanha of fila) {
        if (Date.now() > deadline) break;

        if (campanha.status === "queued") {
          await admin.from("whatsapp_campaigns").update({ status: "running" }).eq("id", campanha.id);
        }

        if (!withinSendWindow(now())) continue;
        const daily = await checkDailyLimit(admin, campanha.organization_id, campanha.channel_session_id);
        if (!daily.allowed) continue;

        resumo.campaignsProcessed += 1;
        await processarCampanha(admin, campanha, deadline, resolvedDeps, resumo);
      }
    }),
  );

  return resumo;
}
