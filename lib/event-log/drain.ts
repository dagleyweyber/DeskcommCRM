/**
 * Cron driver genérico do event_log — a peça prometida em dispatcher.ts.
 *
 * Seleciona SÓ event_types com handler registrado: tipos drenados por crons
 * dedicados (ex. ai_agent.dispatch_requested → agent-dispatcher) não têm
 * handler no registry e ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dispatchEvent,
  getRegisteredHandlers,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { intercalaPorOrganizacao } from "@/lib/event-log/rodizio";
import { logger } from "@/lib/logger";

// Exportado: handlers que precisam saber "esta é minha última chance antes
// do drain marcar `dead`" (ex. lib/meta-ads/send-log.ts) importam daqui em
// vez de duplicar o número — duplicar divergiria no primeiro ajuste.
export const MAX_ATTEMPTS = 5;

/**
 * Quantas linhas LER para cada linha PROCESSADA, para dar material ao rodízio
 * por organização (`lib/event-log/rodizio.ts`).
 *
 * Sem janela, a leitura traz exatamente `limit` linhas — e se uma clínica em
 * rajada ocupa todas elas, não sobra o que intercalar: o rodízio não teria
 * como ser justo com o que nunca foi lido. Com janela, a leitura alcança as
 * organizações que estão atrás na ordem global.
 *
 * 4 e não 20: a leitura extra custa (foi Disk IO em 100% que originou esta
 * entrega). 4× cobre o caso real — uma barulhenta + as demais — sem transformar
 * a cura em uma segunda doença. O índice parcial de `pending` já serve esta
 * consulta; a janela maior lê mais fundo no MESMO índice, não faz varredura nova.
 */
const JANELA_DO_RODIZIO = 4;

export interface DrainSummary {
  scanned: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

function backoffAt(attempts: number): string {
  // 1min, 2min, 4min, 8min... (2^n minutos)
  const minutes = Math.pow(2, attempts);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function drainEventLog(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50;
  const summary: DrainSummary = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };

  const handledTypes = [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
  if (!handledTypes.length) return summary;

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await admin
    .from("event_log")
    // `created_at` viaja porque um consumidor não consegue distinguir "evento de
    // agora" de "evento de três dias parado em `pending`" sem ele — e o drain
    // leva 50 por tick sem janela de recência, então um backlog vira enxurrada
    // de efeitos com data errada no primeiro tick depois de um deploy.
    .select(
      "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at",
    )
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .in("event_type", handledTypes)
    .order("created_at", { ascending: true })
    .limit(limit * JANELA_DO_RODIZIO);

  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });
    return summary;
  }

  // RODÍZIO POR ORGANIZAÇÃO — sem isto, uma clínica em rajada ocupa o tick
  // inteiro (os eventos dela são os mais antigos) e as demais esperam a fila
  // dela esvaziar. Ver `lib/event-log/rodizio.ts` para o porquê completo.
  const selecionadas = intercalaPorOrganizacao(
    (rows ?? []) as unknown as Array<{ organization_id: string }>,
    limit,
  );

  for (const raw of selecionadas) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const results = await dispatchEvent(row);

    const okKeys = results.filter((r) => r.status === "ok" || r.status === "skipped").map((r) => r.consumer_key);
    const consumedBy = [...new Set([...row.consumed_by, ...okKeys])];
    const retry = results.find((r) => r.status === "retry");
    const errors = results.filter((r) => r.status === "error");

    if (retry) {
      // Reagendamento benigno (ex. janela anti-ban): NÃO conta attempt — mesmo
      // que outro handler do mesmo tick tenha retornado erro (esse handler
      // nunca entrou em consumed_by, então ele reroda no próximo tick; aqui só
      // preservamos o last_error dele pra visibilidade/observabilidade).
      // retry_at é opcional no HandlerResult — sem ele, aplica o mesmo backoff
      // do branch de erro pra não busy-loop reprocessando a cada tick.
      const retryAt = retry.retry_at ?? backoffAt(row.attempts + 1);
      await admin
        .from("event_log")
        .update({
          status: "pending",
          consumed_by: consumedBy,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
          ...(errors.length
            ? { last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; ") }
            : {}),
        })
        .eq("id", row.id);
      summary.retried += 1;
    } else if (errors.length) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await admin
        .from("event_log")
        .update({
          status: dead ? "dead" : "pending",
          attempts,
          consumed_by: consumedBy,
          last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
          next_attempt_at: dead ? null : backoffAt(attempts),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      summary[dead ? "dead" : "failed"] += 1;
    } else {
      await admin
        .from("event_log")
        .update({ status: "done", consumed_by: consumedBy, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      summary.done += 1;
    }
  }
  return summary;
}
