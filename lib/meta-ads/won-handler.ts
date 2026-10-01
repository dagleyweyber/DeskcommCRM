/**
 * `lead.won` → Purchase automático pro Meta Conversions API.
 *
 * Handler INDEPENDENTE do motor de automação — convive no mesmo evento
 * `lead.won` que `automationRulesHandler` já escuta (Fase B), sem
 * conflito: o dispatcher filtra cada handler pela própria `key` em
 * `event_log.consumed_by` (lib/event-log/dispatcher.ts). É a
 * simplificação que o usuário pediu: conectar o Meta Ads JÁ liga o envio
 * de Purchase, sem precisar criar regra nenhuma — "lead qualificado" (Fase
 * C2) que fica opcional, dentro do motor de automação.
 *
 * Reaproveita `buildContext` (o mesmo hidratador do motor de automação,
 * Fase B garantiu que ele trata `entity_kind='lead'`) em vez de duplicar a
 * query de lead/contato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { buildContext } from "@/lib/automation/engine";
import { sendMetaCapiEvent } from "@/lib/meta-ads/send";
import { recordCapiSendResult } from "@/lib/meta-ads/send-log";

export const META_CAPI_PURCHASE_CONSUMER_KEY = "meta-capi-purchase";

export async function handleLeadWonForMetaCapi(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const context = await buildContext(admin, row);
  const lead = context.lead as Record<string, unknown> | undefined;
  if (!lead) {
    return { consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "skipped", detail: "no_lead" };
  }
  const contact = context.contact as Record<string, unknown> | undefined;

  const valueCents = lead.value_cents as number | null;
  const currency = lead.currency as string | null;
  // Achado ao vivo (RevitaFio Mossoró): um lead fechado sem valor preenchido
  // ainda assim disparava Purchase, e a Meta EXIGE moeda nesse evento padrão
  // — o envio inteiro era recusado (subcode 2804010). Não tenta o que já
  // sabemos que vai falhar; o dado que falta é no LEAD, não no envio.
  if (valueCents == null || !currency) {
    return { consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "skipped", detail: "no_value" };
  }

  const closedAt = (lead.closed_at as string | null) ?? row.created_at ?? new Date().toISOString();

  const result = await sendMetaCapiEvent(admin, row.organization_id, {
    eventName: "Purchase",
    eventId: row.id,
    eventTimeSeconds: Math.floor(new Date(closedAt).getTime() / 1000),
    valueCents,
    currency,
    phone: (contact?.phone_number as string | null) ?? null,
    sourceMetadata: (lead.source_metadata as Record<string, unknown> | null) ?? null,
  });

  return recordCapiSendResult(admin, {
    consumerKey: META_CAPI_PURCHASE_CONSUMER_KEY,
    organizationId: row.organization_id,
    leadId: lead.id as string,
    eventName: "Purchase",
    result,
    attemptsSoFar: row.attempts,
  });
}

export const metaCapiPurchaseHandler: EventHandler = {
  key: META_CAPI_PURCHASE_CONSUMER_KEY,
  events: ["lead.won"],
  async handle(row) {
    return handleLeadWonForMetaCapi(createAdminClient(), row);
  },
};
