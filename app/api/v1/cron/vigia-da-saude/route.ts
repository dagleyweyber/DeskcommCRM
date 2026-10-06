/**
 * GET /api/v1/cron/vigia-da-saude
 *
 * Roda o painel de `/admin/saude` sozinho e materializa o que achou em
 * `incidents`. Fecha o laço do painel: sem isto, problema só aparece para quem
 * lembra de abrir a tela — com 50 clínicas, "lembrar" não é mecanismo.
 *
 * Auth: mesmo padrão de `event-log-drain` (Bearer INTERNAL_CRON_SECRET, com
 * INTERNAL_SECRET como alternativa).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { vigiaSaudeDasClinicas } from "@/lib/admin/vigia-da-saude";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

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

  try {
    const r = await vigiaSaudeDasClinicas(createAdminClient());
    return ok(
      {
        clinicas_verificadas: r.clinicas_verificadas,
        incidentes_abertos: r.abrir.length,
        incidentes_resolvidos: r.resolver.length,
      },
      { requestId },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[vigia-da-saude.cron] threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}
