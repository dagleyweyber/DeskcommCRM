/**
 * `lead.stage_changed` → evento padrão do Meta CAPI, quando a etapa de
 * DESTINO tem `meta_capi_event_name` marcado (`crm_stages`, migration 0180).
 *
 * Mesmo padrão do Purchase (`won-handler.ts`), mas genérico: o tenant marca
 * QUAL etapa dispara QUAL evento pela tela de Pipelines (mesmo lugar que já
 * marca `is_won`/`is_lost`), em vez de um handler novo a cada sinal. Pedido
 * do usuário era "Lead Qualificado" → Schedule na etapa "Avaliação
 * Agendada", mas o mecanismo serve pra qualquer etapa/evento futuro sem
 * deploy novo — só configuração.
 *
 * Handler INDEPENDENTE — convive no mesmo `lead.stage_changed` que
 * `automationRulesHandler`/`followupGatilhoEtapaHandler` já escutam, via
 * `event_log.consumed_by` (lib/event-log/dispatcher.ts). Deliberadamente NÃO
 * é uma ação do motor de automação (`lib/automation/actions/*`): uma run de
 * automação sempre fecha com `status:"ok"` mesmo quando uma ação falha
 * (`lib/automation/engine.ts`) — não se beneficiaria do reenvio com backoff
 * que este handler ganha de graça via `recordCapiSendResult`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { sendMetaCapiEvent } from "@/lib/meta-ads/send";
import { recordCapiSendResult } from "@/lib/meta-ads/send-log";

export const META_CAPI_STAGE_CONSUMER_KEY = "meta-capi-stage-event";

export async function handleStageChangedForMetaCapi(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const toStageId = row.payload.to_stage_id as string | undefined;
  if (!toStageId) {
    return { consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "no_to_stage" };
  }

  const { data: stage } = await admin
    .from("crm_stages")
    .select("meta_capi_event_name")
    .eq("id", toStageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  const eventName = stage?.meta_capi_event_name as string | null | undefined;
  if (!eventName) {
    return { consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "stage_sem_evento" };
  }

  if (!row.entity_id) {
    return { consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "no_lead" };
  }
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id, contact_id, source_metadata")
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (!lead) {
    return { consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "no_lead" };
  }

  let phone: string | null = null;
  if (lead.contact_id) {
    const { data: contact } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("id", lead.contact_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    phone = (contact?.phone_number as string | null) ?? null;
  }

  // Sem `valueCents`/`currency` de propósito: Schedule/Lead/etc. não carregam
  // valor de venda — só Purchase tem essa semântica (buildCapiPayload já
  // omite `custom_data` quando nenhum dos dois vem preenchido).
  const result = await sendMetaCapiEvent(admin, row.organization_id, {
    eventName,
    eventId: row.id,
    eventTimeSeconds: Math.floor(new Date(row.created_at ?? new Date().toISOString()).getTime() / 1000),
    phone,
    sourceMetadata: (lead.source_metadata as Record<string, unknown> | null) ?? null,
  });

  return recordCapiSendResult(admin, {
    consumerKey: META_CAPI_STAGE_CONSUMER_KEY,
    organizationId: row.organization_id,
    leadId: lead.id as string,
    eventName,
    result,
    attemptsSoFar: row.attempts,
  });
}

export const metaCapiStageHandler: EventHandler = {
  key: META_CAPI_STAGE_CONSUMER_KEY,
  events: ["lead.stage_changed"],
  async handle(row) {
    return handleStageChangedForMetaCapi(createAdminClient(), row);
  },
};
