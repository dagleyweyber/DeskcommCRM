/**
 * Ponto único que todo handler de Meta CAPI (Purchase, Schedule, e o que vier
 * depois) usa pra registrar o resultado de um envio e decidir o que devolver
 * pro dispatcher do event_log.
 *
 * Achado ao vivo (RevitaFio Mossoró): `handleLeadWonForMetaCapi` sempre
 * devolvia `status: "ok"` mesmo quando o envio falhava — por isso o reenvio
 * com backoff que `lib/event-log/drain.ts` JÁ TEM pronto nunca era acionado,
 * e 8 de 14 tentativas de Purchase se perderam em silêncio. Esta função é a
 * correção: `status: "error"` em falha liga o reenvio de graça, sem
 * precisar de fila nova.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { MAX_ATTEMPTS } from "@/lib/event-log/drain";
import type { HandlerResult } from "@/lib/event-log/dispatcher";
import type { SendMetaCapiResult } from "@/lib/meta-ads/send";
import { logger } from "@/lib/logger";

export interface RecordCapiSendResultInput {
  consumerKey: string;
  organizationId: string;
  leadId: string;
  eventName: string;
  result: SendMetaCapiResult;
  /** `EventRow.attempts` — quantas vezes o drain JÁ tentou antes desta chamada. */
  attemptsSoFar: number;
}

export async function recordCapiSendResult(
  admin: SupabaseClient,
  input: RecordCapiSendResultInput,
): Promise<HandlerResult> {
  const { consumerKey, organizationId, leadId, eventName, result, attemptsSoFar } = input;

  // "skipped" (sem credencial, sem valor/moeda) é estado normal de quem não
  // ativou o recurso ou tem um dado faltando no lead — não vira linha de log,
  // senão toda org sem Meta Ads conectado encheria a tabela à toa (mesmo
  // raciocínio que já valia aqui antes desta função existir).
  if (result.status !== "skipped") {
    const { error } = await admin.from("meta_capi_send_log").insert({
      organization_id: organizationId,
      lead_id: leadId,
      event_name: eventName,
      status: result.status,
      meta_error: result.error ?? null,
    });
    if (error) {
      logger.warn("[meta-ads] falha ao gravar meta_capi_send_log", {
        organization_id: organizationId,
        lead_id: leadId,
        event_name: eventName,
        error: error.message,
      });
    }
  }

  if (result.status !== "failed") {
    return { consumer_key: consumerKey, status: "ok" };
  }

  logger.warn("[meta-ads] envio ao Meta CAPI falhou", {
    organization_id: organizationId,
    lead_id: leadId,
    event_name: eventName,
    error: result.error,
  });

  // `attemptsSoFar` é o que o drain já gastou ANTES desta chamada. Se esta
  // falha for a que completa MAX_ATTEMPTS, o drain marca o evento "dead" e
  // NUNCA MAIS chama este handler pra ele — o aviso tem que sair AGORA,
  // porque não existe um "depois" pra esse evento específico.
  if (attemptsSoFar + 1 >= MAX_ATTEMPTS) {
    const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "meta_capi_send_exhausted",
      severity: "critical",
      title: `Sinal "${eventName}" não chegou ao Meta Ads`,
      body:
        `Tentamos enviar o evento "${eventName}" pro Meta Ads ${MAX_ATTEMPTS} vezes e todas falharam. ` +
        `Esse lead não está contando nos dados de otimização de campanha do Meta. ` +
        `Último erro: ${result.error ?? "desconhecido"}`,
      ref_kind: "crm_lead",
      ref_id: leadId,
    });
    if (inboxErr) {
      logger.error("[meta-ads] aviso na Central (esgotamento de reenvio) falhou", {
        organization_id: organizationId,
        lead_id: leadId,
        event_name: eventName,
        error: inboxErr.message,
      });
    }
  }

  return { consumer_key: consumerKey, status: "error", detail: result.error };
}
