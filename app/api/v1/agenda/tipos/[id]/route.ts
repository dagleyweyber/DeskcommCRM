/** PATCH /api/v1/agenda/tipos/[id] — edita um serviço e as salas onde ele pode ser feito (manager+). */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { updateEventTypeSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../../_comum";
import { comRoomIds, gravaSalasDoTipo } from "../_salas";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active, position, calendar_event_type_rooms(room_id)";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(updateEventTypeSchema, req, requestId);
  if (!corpo.ok) return corpo.response;
  const { room_ids: roomIds, ...patch } = corpo.data;

  const { data: existe, error: buscaErr } = await supabase
    .from("calendar_event_types")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (buscaErr) return fail("internal_error", buscaErr.message, 500, { requestId });
  if (!existe) return fail("not_found", "Serviço não encontrado.", 404, { requestId });

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("calendar_event_types")
      .update(patch)
      .eq("organization_id", authz.org.orgId)
      .eq("id", id);
    if (error) return fail("internal_error", error.message, 500, { requestId });
  }

  if (roomIds !== undefined) {
    const salas = await gravaSalasDoTipo(supabase, authz.org.orgId, id, roomIds);
    if (!salas.ok) return fail("unprocessable_entity", "Sala inválida na lista.", 422, { requestId });
  }

  await audit({
    action: "calendar_event_type.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_event_type",
    resourceId: id,
    metadata: { campos: [...Object.keys(patch), ...(roomIds !== undefined ? ["room_ids"] : [])] },
    requestId,
  });

  const { data } = await supabase.from("calendar_event_types").select(COLUNAS).eq("id", id).single();
  return ok(comRoomIds(data as unknown as { calendar_event_type_rooms: { room_id: string }[] | null }), { requestId });
}
