/**
 * GET /api/v1/cron/event-log-retention
 *
 * Apaga em lote `event_log` `done`/`dead` com mais de 30 dias (configurável
 * via query). Mesmo padrão de `storage-redaction`: batch pequeno por
 * chamada, repetido pelo cron — nunca um DELETE gigante de uma vez (ver
 * `lib/event-log/retention.ts`).
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (ou `INTERNAL_SECRET`
 * como fallback), mesmo padrão de `event-log-drain`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { pruneEventLog } from "@/lib/event-log/retention";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  const cronSecret = env.INTERNAL_CRON_SECRET;
  const fallbackSecret = env.INTERNAL_SECRET;
  const accepted: string[] = [];
  if (cronSecret) accepted.push(cronSecret);
  if (fallbackSecret) accepted.push(fallbackSecret);

  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const daysParam = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  // Piso de 7 dias: um valor menor por engano apagaria evento ainda útil pra
  // depurar um incidente da última semana — o mesmo tipo de janela curta
  // demais que motivou a correção de hoje.
  const retentionDays =
    Number.isFinite(daysParam) && daysParam >= MIN_RETENTION_DAYS ? daysParam : DEFAULT_RETENTION_DAYS;

  const stats = await pruneEventLog(createAdminClient(), { limit, retentionDays });
  return ok(stats, { requestId });
}
