/**
 * GET  /api/v1/campaigns — lista campanhas da org, com progresso.
 * POST /api/v1/campaigns — cria em `draft`: resolve o público (snapshot,
 * uma vez), resolve as variáveis por destinatário, grava tudo. NÃO dispara
 * nada — só `POST .../start` muda isso (ver o cabeçalho da migration 0167
 * pra por quê o criar/iniciar é em dois passos).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { resolveAudience, type AudienceFilter } from "@/lib/campaigns/audience";
import { gravarLinks, prepararLinks } from "@/lib/campaigns/links-da-campanha";
import { BLOCO_MAXIMO, BLOCO_MINIMO, ESPERA_MAXIMA_MIN, ESPERA_MINIMA_MIN } from "@/lib/campaigns/blocos";
import { aplicarRegrasDeEnvio, regrasDeEnvioSchema, regrasDoCorpo } from "@/lib/campaigns/regras-de-envio";
import { VELOCIDADE_PADRAO, VELOCIDADES_DA_CAMPANHA } from "@/lib/campaigns/velocidade";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import { resolveValuesForRecipient, type VariableMapping } from "@/lib/messaging/variable-mapping";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const variableSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("contact_name") }),
  z.object({ kind: z.literal("contact_first_name") }),
]);

const audienceSchema: z.ZodType<AudienceFilter> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tag"), tag: z.string().trim().min(1).max(60) }),
  z.object({
    kind: z.literal("pipeline_stage"),
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid(),
  }),
  z.object({ kind: z.literal("all_contacts") }),
]);

const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  channel_session_id: z.string().uuid(),
  template_name: z.string().trim().min(1).max(512),
  template_language: z.string().trim().min(2).max(16),
  variable_mapping: z.record(z.string(), variableSourceSchema).default({}),
  audience: audienceSchema,
  regras: regrasDeEnvioSchema.default({}),
  velocidade: z.enum(VELOCIDADES_DA_CAMPANHA).default(VELOCIDADE_PADRAO),
  // Espera programada: a cada `tamanho` mensagens, `espera_minutos` de espera. `null` = sem blocos.
  blocos: z
    .object({
      tamanho: z.number().int().min(BLOCO_MINIMO).max(BLOCO_MAXIMO),
      espera_minutos: z.number().int().min(ESPERA_MINIMA_MIN).max(ESPERA_MAXIMA_MIN),
    })
    .nullable()
    .default(null),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("whatsapp_campaigns")
    .select(
      "id, name, status, channel_session_id, template_name, template_language, total_recipients, sent_count, failed_count, created_at, started_at, completed_at, velocidade, pausa_motivo, pausa_detalhe, pausada_em, bloco_tamanho, bloco_espera_minutos, bloco_enviados, proximo_bloco_em",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  // Cliques do botão de link da campanha (migration 0216): o retorno de quem disparou.
  const campanhas = data ?? [];
  const { data: links } = campanhas.length
    ? await admin
        .from("whatsapp_campaign_links")
        .select("campaign_id, cliques")
        .eq("organization_id", authz.org.orgId)
        .in("campaign_id", campanhas.map((c) => c.id))
    : { data: [] };
  const cliques = new Map<string, number>();
  for (const l of (links ?? []) as Array<{ campaign_id: string; cliques: number }>) {
    cliques.set(l.campaign_id, (cliques.get(l.campaign_id) ?? 0) + l.cliques);
  }
  return ok(
    { campaigns: campanhas.map((c) => ({ ...c, cliques: cliques.get(c.id) ?? null })) },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const parsed = createCampaignSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Dados da campanha inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const admin = createAdminClient();

  // O canal precisa ser desta org e estar de pé — sem isso a campanha
  // nasceria pra nunca conseguir mandar nada.
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, status, provider")
    .eq("id", input.channel_session_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!sessao) return fail("invalid_request", "Canal não encontrado nesta organização.", 422, { requestId });
  // Campanha em massa é da API oficial: um canal de outro tipo (QR code) passava na checagem
  // acima e a campanha nascia para nunca conseguir mandar o modelo.
  if (sessao.provider !== CHANNEL_PROVIDER_META) {
    return fail("invalid_request", "Campanhas saem só por um número da API oficial.", 422, { requestId });
  }
  if (sessao.status !== "WORKING") {
    return fail("invalid_request", "O canal escolhido não está conectado.", 422, { requestId });
  }

  // O template precisa estar APROVADO — sem isso todo destinatário nasceria
  // condenado a `failed` no primeiro tick do despachante.
  const { data: template } = await admin
    .from("meta_templates")
    .select("status, components, parameter_format")
    .eq("organization_id", authz.org.orgId)
    .eq("channel_session_id", input.channel_session_id)
    .eq("name", input.template_name)
    .eq("language", input.template_language)
    .maybeSingle();
  if (!template || template.status !== "APPROVED") {
    return fail(
      "invalid_request",
      "Este modelo não está aprovado para este canal — sincronize em Conexões antes de criar a campanha.",
      422,
      { requestId },
    );
  }

  // Toda variável do modelo precisa de uma origem. Sem isso o primeiro tick do despachante
  // devolveria `template_missing_values` para TODO destinatário — a mesma razão de recusar
  // canal fora do ar e modelo não aprovado, logo acima.
  const faltando = valoresSemFonte(
    {
      name: input.template_name,
      language: input.template_language,
      parameter_format: template.parameter_format ?? undefined,
      components: template.components as Definicao["components"],
    },
    input.variable_mapping as VariableMapping,
  );
  if (faltando.length > 0) {
    return fail("invalid_request", fraseDosValoresSemFonte(faltando), 422, {
      requestId,
      details: { variaveis_sem_origem: faltando.map((f) => f.rotulo) },
    });
  }

  // Botão de link escolhido na campanha: o destino colado vira um código curto, e é o
  // código que entra no mapeamento gravado e nos valores de cada destinatário.
  const links = prepararLinks(template.components, input.variable_mapping as VariableMapping);
  if (!links.ok) return fail("invalid_request", links.mensagem, 422, { requestId });
  const mapping = links.mapping;

  // As regras vão junto do filtro em `audience_filter`: é o registro de COMO o
  // público foi montado, e o público em si já fica materializado nos destinatários.
  const recorte = await aplicarRegrasDeEnvio(
    admin,
    authz.org.orgId,
    await resolveAudience(admin, authz.org.orgId, input.audience),
    regrasDoCorpo(input.regras),
  );
  const publico = recorte.selecionados;
  if (publico.length === 0 && recorte.doFiltro > 0) {
    return fail(
      "invalid_request",
      `Todos os ${recorte.doFiltro} contato(s) desse público já receberam campanha no período escolhido.`,
      422,
      { requestId },
    );
  }

  const { data: campanha, error: erroCriar } = await admin
    .from("whatsapp_campaigns")
    .insert({
      organization_id: authz.org.orgId,
      name: input.name,
      channel_session_id: input.channel_session_id,
      template_name: input.template_name,
      template_language: input.template_language,
      variable_mapping: mapping,
      audience_filter: { ...input.audience, regras: input.regras },
      velocidade: input.velocidade,
      bloco_tamanho: input.blocos?.tamanho ?? null,
      bloco_espera_minutos: input.blocos?.espera_minutos ?? null,
      status: "draft",
      total_recipients: publico.length,
      created_by: authz.user.id,
    })
    .select("id, name, status, total_recipients")
    .single();

  if (erroCriar || !campanha) {
    return fail("internal_error", erroCriar?.message ?? "Falha ao criar a campanha.", 500, {
      requestId,
    });
  }

  const { error: erroLinks } = await gravarLinks(admin, authz.org.orgId, campanha.id, links.links);
  if (erroLinks) {
    // Sem a linha do link o botão levaria a um código que não existe: desfaz o rascunho.
    await admin.from("whatsapp_campaigns").delete().eq("id", campanha.id).eq("organization_id", authz.org.orgId);
    return fail("internal_error", erroLinks.message, 500, { requestId });
  }

  if (publico.length > 0) {
    const linhas = publico.map((membro) => ({
      campaign_id: campanha.id,
      organization_id: authz.org.orgId,
      contact_id: membro.contactId,
      lead_id: membro.leadId,
      resolved_values: resolveValuesForRecipient(mapping, membro),
      status: "pending",
    }));
    const { error: erroDestinatarios } = await admin
      .from("whatsapp_campaign_recipients")
      .insert(linhas);
    if (erroDestinatarios) {
      return fail("internal_error", erroDestinatarios.message, 500, { requestId });
    }
  }

  void audit({
    action: "campaign.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: campanha.id,
    requestId,
    metadata: {
      template_name: input.template_name,
      audience: input.audience,
      regras: input.regras,
      velocidade: input.velocidade,
      blocos: input.blocos,
      total_recipients: publico.length,
      excluidos_por_recente: recorte.excluidosPorRecente,
      cortados_pelo_limite: recorte.cortadosPeloLimite,
    },
  });

  return ok(campanha, { status: 201, requestId });
}
