/**
 * Grava em quais salas um serviço pode ser feito (`calendar_event_type_rooms`,
 * migration 0200) — troca o conjunto inteiro. Lista vazia = qualquer sala.
 * Compartilhado pelo POST e pelo PATCH de tipos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function gravaSalasDoTipo(
  supabase: SupabaseClient,
  organizationId: string,
  eventTypeId: string,
  roomIds: string[],
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const unicos = [...new Set(roomIds)];
  if (unicos.length > 0) {
    // Só salas DESTA organização — o id vem do corpo da requisição.
    const { data: salas, error } = await supabase
      .from("calendar_rooms")
      .select("id")
      .eq("organization_id", organizationId)
      .in("id", unicos);
    if (error) return { ok: false, erro: error.message };
    if ((salas ?? []).length !== unicos.length) return { ok: false, erro: "sala_invalida" };
  }

  const { error: delErr } = await supabase
    .from("calendar_event_type_rooms")
    .delete()
    .eq("organization_id", organizationId)
    .eq("event_type_id", eventTypeId);
  if (delErr) return { ok: false, erro: delErr.message };

  if (unicos.length === 0) return { ok: true };
  const { error: insErr } = await supabase
    .from("calendar_event_type_rooms")
    .insert(unicos.map((roomId) => ({ organization_id: organizationId, event_type_id: eventTypeId, room_id: roomId })));
  if (insErr) return { ok: false, erro: insErr.message };
  return { ok: true };
}

/** `calendar_event_type_rooms(room_id)` embutido → `room_ids: string[]`. */
export function comRoomIds<T extends { calendar_event_type_rooms?: { room_id: string }[] | null }>(
  linha: T,
): Omit<T, "calendar_event_type_rooms"> & { room_ids: string[] } {
  const { calendar_event_type_rooms: vinculos, ...resto } = linha;
  return { ...resto, room_ids: (vinculos ?? []).map((v) => v.room_id) };
}
