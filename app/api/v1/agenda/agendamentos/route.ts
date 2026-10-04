/**
 * POST /api/v1/agenda/agendamentos — marca um compromisso (handler em ./_handler.ts).
 * GET  /api/v1/agenda/agendamentos — lista no período, pra montar a grade.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas";
import { marcarAgendamentoSchema, type MarcarAgendamentoInput } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { marcarAgendamentoHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_appointments" });
  if (!authz.ok) return authz.response;

  let input: MarcarAgendamentoInput;
  try {
    input = await validateRequest(marcarAgendamentoSchema, req);
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
    const compromisso = await marcarAgendamentoHandler(
      supabase,
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId },
      input,
    );
    return ok(compromisso, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_appointments" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const de = searchParams.get("de");
  const ate = searchParams.get("ate");
  if (!de || !ate) {
    return fail("unprocessable_entity", "Informe de e ate (ISO).", 422, { requestId });
  }
  const ownerUserId = searchParams.get("owner_user_id");

  let query = supabase
    .from("calendar_appointments")
    .select(
      "id, event_type_id, title, starts_at, ends_at, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, revision, contacts:contact_id(display_name, phone_number)",
    )
    .eq("organization_id", authz.org.orgId)
    .gte("starts_at", de)
    .lte("starts_at", ate)
    .order("starts_at", { ascending: true });
  if (ownerUserId) query = query.eq("owner_user_id", ownerUserId);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}
