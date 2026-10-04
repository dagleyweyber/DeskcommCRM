/**
 * PATCH  /api/v1/agenda/agendamentos/[id] — remarca ou muda status (confirmar/concluir/no-show).
 * DELETE /api/v1/agenda/agendamentos/[id] — cancela (idempotente).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas";
import { alterarAgendamentoSchema, cancelarAgendamentoSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { alterarAgendamentoHandler, cancelarAgendamentoHandler } from "../_handler";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_appointments" });
  if (!authz.ok) return authz.response;

  let input;
  try {
    input = await validateRequest(alterarAgendamentoSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const compromisso = await alterarAgendamentoHandler(
      supabase,
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId },
      id,
      input,
    );
    return ok(compromisso, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_appointments" });
  if (!authz.ok) return authz.response;

  let input;
  try {
    input = await validateRequest(cancelarAgendamentoSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const compromisso = await cancelarAgendamentoHandler(
      supabase,
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId },
      id,
      input,
    );
    return ok(compromisso, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
