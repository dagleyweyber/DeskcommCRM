/**
 * POST /api/v1/leads/[id]/mark-existing-customer
 *
 * "Cliente já existente", Fase 3 — reconhecimento manual (contexto completo
 * em `lib/leads/marcar-cliente-existente.ts`). Fecha o negócio com
 * status='existing_customer' + closed_at, SEM mover stage (diferente de
 * /win e /lose, que fecham movendo pro stage terminal do funil) — este
 * desfecho não corresponde a nenhuma etapa visível.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcarClienteExistente } from "@/lib/leads/marcar-cliente-existente";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only) — mesmo gate de /win e /lose.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  try {
    const { lead } = await marcarClienteExistente(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
      },
      { leadId },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
