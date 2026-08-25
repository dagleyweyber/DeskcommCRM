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
import { logger } from "@/lib/logger";

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

  const closedAt = (lead.closed_at as string | null) ?? row.created_at ?? new Date().toISOString();

  const result = await sendMetaCapiEvent(admin, row.organization_id, {
    eventName: "Purchase",
    eventId: row.id,
    eventTimeSeconds: Math.floor(new Date(closedAt).getTime() / 1000),
    valueCents: lead.value_cents as number | null,
    currency: lead.currency as string | null,
    phone: (contact?.phone_number as string | null) ?? null,
    sourceMetadata: (lead.source_metadata as Record<string, unknown> | null) ?? null,
  });

  // "skipped" (sem credencial) é o estado normal de quem não ativou o
  // recurso — não vira linha de log, senão toda venda de toda org sem Meta
  // Ads conectado encheria a tabela à toa.
  if (result.status !== "skipped") {
    const { error } = await admin.from("meta_capi_send_log").insert({
      organization_id: row.organization_id,
      lead_id: lead.id,
      event_name: "Purchase",
      status: result.status,
      meta_error: result.error ?? null,
    });
    if (error) {
      logger.warn("[meta-ads] falha ao gravar meta_capi_send_log", {
        organization_id: row.organization_id,
        lead_id: lead.id,
        error: error.message,
      });
    }
  }

  if (result.status === "failed") {
    logger.warn("[meta-ads] envio de Purchase falhou", {
      organization_id: row.organization_id,
      lead_id: lead.id,
      error: result.error,
    });
  }

  return { consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "ok" };
}

export const metaCapiPurchaseHandler: EventHandler = {
  key: META_CAPI_PURCHASE_CONSUMER_KEY,
  events: ["lead.won"],
  async handle(row) {
    return handleLeadWonForMetaCapi(createAdminClient(), row);
  },
};
