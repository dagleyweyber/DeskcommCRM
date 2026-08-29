/**
 * `lead.won` → primeira venda marca o contato como cliente — "Cliente já
 * existente", Fase 2 (contexto completo na migration 0164, e no reconhecimento
 * MANUAL equivalente em `lib/leads/marcar-cliente-existente.ts`).
 *
 * Handler INDEPENDENTE dos outros que já escutam `lead.won` (motor de
 * automação, Purchase pro Meta Conversions API) — mesmo mecanismo de
 * `won-handler.ts`: o dispatcher filtra cada handler pela própria `key` em
 * `event_log.consumed_by` (lib/event-log/dispatcher.ts), sem conflito.
 *
 * Reaproveita `buildContext` (o mesmo hidratador do motor de automação) em
 * vez de duplicar a query de lead — mesma razão do handler de Purchase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { buildContext } from "@/lib/automation/engine";

export const CLIENTE_EXISTENTE_WON_CONSUMER_KEY = "cliente-existente-marcar-no-won";

export async function handleLeadWonForClienteExistente(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const context = await buildContext(admin, row);
  const lead = context.lead as Record<string, unknown> | undefined;
  if (!lead) {
    return { consumer_key: CLIENTE_EXISTENTE_WON_CONSUMER_KEY, status: "skipped", detail: "no_lead" };
  }

  const contactId = lead.contact_id as string | null;
  if (!contactId) {
    // Lead ganho sem contato vinculado (criado à mão, webhook) — ninguém pra
    // marcar como cliente. Estado legítimo, não erro.
    return { consumer_key: CLIENTE_EXISTENTE_WON_CONSUMER_KEY, status: "skipped", detail: "no_contact" };
  }

  const closedAt = (lead.closed_at as string | null) ?? row.created_at ?? new Date().toISOString();

  // `.is(..., null)` faz o papel do `coalesce`: só grava se o contato ainda
  // não tem `became_customer_at` — a 2ª venda da mesma pessoa não reescreve
  // "desde quando" ela é cliente.
  const { error } = await admin
    .from("contacts")
    .update({ became_customer_at: closedAt })
    .eq("id", contactId)
    .eq("organization_id", row.organization_id)
    .is("became_customer_at", null);

  if (error) {
    return { consumer_key: CLIENTE_EXISTENTE_WON_CONSUMER_KEY, status: "error", detail: error.message };
  }
  return { consumer_key: CLIENTE_EXISTENTE_WON_CONSUMER_KEY, status: "ok" };
}

export const clienteExistenteWonHandler: EventHandler = {
  key: CLIENTE_EXISTENTE_WON_CONSUMER_KEY,
  events: ["lead.won"],
  async handle(row) {
    return handleLeadWonForClienteExistente(createAdminClient(), row);
  },
};
