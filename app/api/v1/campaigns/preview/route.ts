/**
 * POST /api/v1/campaigns/preview — quantos contatos este filtro atinge,
 * SEM gravar nada.
 *
 * Existe pro operador ver o número ANTES de criar a campanha: um filtro de
 * etapa errado disparando pra centenas de pessoas sem ninguém perceber é
 * exatamente o que a tela de "Nova campanha" existe para evitar (ver o
 * cabeçalho da migration 0167).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resolveAudience, type AudienceFilter } from "@/lib/campaigns/audience";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const audienceSchema: z.ZodType<AudienceFilter> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tag"), tag: z.string().trim().min(1).max(60) }),
  z.object({
    kind: z.literal("pipeline_stage"),
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid(),
  }),
  z.object({ kind: z.literal("all_contacts") }),
]);

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const parsed = audienceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Filtro de público inválido.", 422, { requestId });
  }

  const publico = await resolveAudience(createAdminClient(), authz.org.orgId, parsed.data);
  return ok({ total: publico.length }, { requestId });
}
