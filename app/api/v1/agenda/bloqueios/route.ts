/**
 * GET  /api/v1/agenda/bloqueios?de=YYYY-MM-DD&ate=YYYY-MM-DD — bloqueios de
 *      sala e da clínica inteira no período (a grade pinta de cinza).
 * POST /api/v1/agenda/bloqueios — cria (manager+). `room_id` nulo = clínica
 *      inteira (feriado). Mora em `calendar_availability_exceptions`
 *      (kind='unavailable'), a mesma tabela que o motor já lê — nenhuma regra
 *      nova de disponibilidade.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createBloqueioSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../_comum";

export const dynamic = "force-dynamic";

const COLUNAS = "id, room_id, date, start_time, end_time, reason";
const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_availability_exceptions" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const de = searchParams.get("de") ?? "";
  const ate = searchParams.get("ate") ?? "";
  if (!DATA_CIVIL.test(de) || !DATA_CIVIL.test(ate)) {
    return fail("unprocessable_entity", "Informe de e ate (YYYY-MM-DD).", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("calendar_availability_exceptions")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("kind", "unavailable")
    .is("user_id", null)
    .gte("date", de)
    .lte("date", ate)
    .order("date", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_availability_exceptions" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(createBloqueioSchema, req, requestId);
  if (!corpo.ok) return corpo.response;
  const input = corpo.data;

  if (input.room_id) {
    const { data: sala } = await supabase
      .from("calendar_rooms")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", input.room_id)
      .maybeSingle();
    if (!sala) return fail("not_found", "Sala não encontrada.", 404, { requestId });
  }

  const { data, error } = await supabase
    .from("calendar_availability_exceptions")
    .insert({
      organization_id: authz.org.orgId,
      user_id: null,
      room_id: input.room_id,
      date: input.date,
      kind: "unavailable",
      start_time: input.start_time ?? null,
      end_time: input.end_time ?? null,
      reason: input.reason ?? null,
    })
    .select(COLUNAS)
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "calendar_block.created",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_availability_exception",
    resourceId: (data as { id: string }).id,
    requestId,
  });

  return ok(data, { status: 201, requestId });
}
