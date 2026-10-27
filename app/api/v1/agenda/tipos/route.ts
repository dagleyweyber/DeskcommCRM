/**
 * GET  /api/v1/agenda/tipos — lista tipos de compromisso (serviços) da
 * organização, com as salas onde cada um pode ser feito (`room_ids`).
 * POST /api/v1/agenda/tipos — cria um tipo novo (manager+, mesmo piso de
 * `calendar_event_types_write` na RLS).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createEventTypeSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../_comum";
import { comRoomIds, gravaSalasDoTipo } from "./_salas";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active, position, calendar_event_type_rooms(room_id)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const incluirInativos = searchParams.get("incluir_inativos") === "true";

  let query = supabase
    .from("calendar_event_types")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("position", { ascending: true });
  if (!incluirInativos) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(
    ((data ?? []) as unknown as { calendar_event_type_rooms: { room_id: string }[] | null }[]).map(comRoomIds),
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(createEventTypeSchema, req, requestId);
  if (!corpo.ok) return corpo.response;
  const { room_ids: roomIds, ...input } = corpo.data;

  const { data, error } = await supabase
    .from("calendar_event_types")
    .insert({ organization_id: authz.org.orgId, ...input })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe um serviço com este nome.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }
  const id = (data as { id: string }).id;

  if (roomIds && roomIds.length > 0) {
    const salas = await gravaSalasDoTipo(supabase, authz.org.orgId, id, roomIds);
    if (!salas.ok) {
      return fail("unprocessable_entity", "Serviço criado, mas as salas não foram salvas — confira a lista de salas.", 422, { requestId });
    }
  }

  await audit({
    action: "calendar_event_type.created",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_event_type",
    resourceId: id,
    requestId,
  });

  const { data: criado } = await supabase.from("calendar_event_types").select(COLUNAS).eq("id", id).single();
  return ok(comRoomIds(criado as unknown as { calendar_event_type_rooms: { room_id: string }[] | null }), {
    status: 201,
    requestId,
  });
}
