/**
 * GET  /api/v1/agenda/tipos — lista tipos de compromisso da organização.
 * POST /api/v1/agenda/tipos — cria um tipo novo (manager+, mesmo piso de
 * `calendar_event_types_write` na RLS).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas";
import { createEventTypeSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const incluirInativos = searchParams.get("incluir_inativos") === "true";

  let query = supabase
    .from("calendar_event_types")
    .select(
      "id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active, position",
    )
    .eq("organization_id", authz.org.orgId)
    .order("position", { ascending: true });
  if (!incluirInativos) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;

  let input;
  try {
    input = await validateRequest(createEventTypeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const { data, error } = await supabase
    .from("calendar_event_types")
    .insert({ organization_id: authz.org.orgId, ...input })
    .select(
      "id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active",
    )
    .single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe um tipo com este identificador.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "calendar_event_type.created",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_event_type",
    resourceId: (data as { id: string }).id,
    requestId,
  });

  return ok(data, { status: 201, requestId });
}
