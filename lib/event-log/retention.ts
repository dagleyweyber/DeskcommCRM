/**
 * event_log retention — apaga `done`/`dead` antigos, em lotes pequenos.
 *
 * Achado ao vivo (incidente de performance da RevitaFio Mossoró, mesmo dia da
 * 0183): `event_log` nunca teve NENHUMA limpeza. A 0183 resolveu as linhas
 * que nunca saíam de `pending`; esta peça resolve a outra metade do mesmo
 * problema — mesmo linha que TERMINA corretamente (`done`/`dead`) fica no
 * banco pra sempre. Com mais clínicas entrando, essa tabela só cresce, sem
 * teto, e cada organização nova acelera isso.
 *
 * `event_log` é bus de coordenação interno ("Bus interno do CRM... Workers
 * consomem", comentário da própria tabela), não log de auditoria/compliance
 * — isso vive em `api_audit_log` (retenção de 5 anos, regra própria). Uma vez
 * que um evento terminou (`done`/`dead`), seu valor é só depuração de curto
 * prazo; 30 dias é generoso pra isso e não compete com o que a doutrina de
 * auditoria exige.
 *
 * Em LOTES, não um DELETE gigante de uma vez: um UPDATE de 20 mil linhas na
 * mesma tabela, horas antes, é o suspeito nº1 do pico de Disk IO que motivou
 * esta correção (autovacuum pesado depois). Lotes pequenos, chamados
 * repetidamente pelo cron, deixam o trabalho se espalhar no tempo em vez de
 * competir de uma vez com tráfego real.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

export interface RetentionStats {
  deleted: number;
}

const DEFAULT_BATCH = 500;
const DEFAULT_RETENTION_DAYS = 30;

export async function pruneEventLog(
  admin: SupabaseClient,
  opts: { limit?: number; retentionDays?: number } = {},
): Promise<RetentionStats> {
  const limit = opts.limit ?? DEFAULT_BATCH;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const threshold = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Seleciona só os ids primeiro: o índice parcial (migration 0184) cobre
  // exatamente este filtro, então achar o lote é barato mesmo com a tabela
  // grande — o DELETE em si fica restrito aos ids já escolhidos.
  const { data: rows, error: selErr } = await admin
    .from("event_log")
    .select("id")
    .in("status", ["done", "dead"])
    .lt("updated_at", threshold)
    .limit(limit);

  if (selErr) {
    logger.error("[event-log.retention] select failed", { error: selErr.message });
    return { deleted: 0 };
  }

  const ids = (rows ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return { deleted: 0 };

  const { error: delErr } = await admin.from("event_log").delete().in("id", ids);

  if (delErr) {
    logger.error("[event-log.retention] delete failed", { error: delErr.message });
    return { deleted: 0 };
  }

  return { deleted: ids.length };
}
