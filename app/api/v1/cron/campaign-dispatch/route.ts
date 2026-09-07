/**
 * GET/POST /api/v1/cron/campaign-dispatch — dispara um lote de campanhas em
 * `queued`/`running`, a cada minuto (ver `docker/scheduler/entrypoint.sh`).
 *
 * A REGRA vive em `lib/campaigns/dispatch.ts` (`dispatchCampaignsTick`),
 * separada do handler HTTP pelo mesmo motivo de todo cron deste repo: o
 * teste exercita a regra sem montar request/auth, e o handler fica sendo só
 * borda.
 *
 * Auth: mesmo contrato dos demais crons — `Authorization: Bearer` contra
 * `INTERNAL_CRON_SECRET`/`INTERNAL_SECRET`, fail-closed.
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` do `docker-compose.prod.yml`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { dispatchCampaignsTick } from "@/lib/campaigns/dispatch";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const resumo = await dispatchCampaignsTick(createAdminClient());
    return ok(resumo, { requestId });
  } catch (err) {
    logger.error("[cron/campaign-dispatch] tick falhou", {
      detail: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", err instanceof Error ? err.message : "dispatch_failed", 500, {
      requestId,
    });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
