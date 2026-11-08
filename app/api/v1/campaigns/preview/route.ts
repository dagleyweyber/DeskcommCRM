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
import { aplicarRegrasDeEnvio, regrasDeEnvioSchema, regrasDoCorpo } from "@/lib/campaigns/regras-de-envio";
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

  // O corpo é o filtro com as regras ao lado (`{kind, tag, excluir_quem_recebeu_dias, limite}`):
  // cada schema lê só os seus campos.
  const corpo = await req.json().catch(() => null);
  const parsed = audienceSchema.safeParse(corpo);
  const regras = regrasDeEnvioSchema.safeParse(corpo ?? {});
  if (!parsed.success || !regras.success) {
    return fail("invalid_request", "Filtro de público inválido.", 422, { requestId });
  }

  const admin = createAdminClient();
  const publico = await resolveAudience(admin, authz.org.orgId, parsed.data);
  const r = await aplicarRegrasDeEnvio(admin, authz.org.orgId, publico, regrasDoCorpo(regras.data));
  return ok(
    {
      total: r.selecionados.length,
      do_filtro: r.doFiltro,
      excluidos_por_recente: r.excluidosPorRecente,
      cortados_pelo_limite: r.cortadosPeloLimite,
    },
    { requestId },
  );
}
