/**
 * PATCH /api/v1/agenda/salas/[id] — renomeia, muda horário próprio, ordem ou
 * desativa a sala (manager+).
 *
 * Desativar é a única "remoção": compromisso aponta para a sala com FK
 * `on delete restrict`, e o histórico precisa continuar dizendo onde foi
 * atendido. Sala com compromisso FUTURO não desativa — senão esses clientes
 * sumiriam da grade sem ninguém remarcar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { STATUS_QUE_OCUPAM } from "@/lib/agenda/tipos";
import { updateSalaSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../../_comum";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_rooms" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(updateSalaSchema, req, requestId);
  if (!corpo.ok) return corpo.response;
  const input = corpo.data;

  if (input.is_active === false) {
    const { count, error: contaErr } = await supabase
      .from("calendar_appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", authz.org.orgId)
      .eq("room_id", id)
      .in("status", STATUS_QUE_OCUPAM)
      .gte("starts_at", new Date().toISOString());
    if (contaErr) return fail("internal_error", contaErr.message, 500, { requestId });
    if ((count ?? 0) > 0) {
      return fail(
        "unprocessable_entity",
        `Esta sala tem ${count} compromisso(s) futuro(s). Remarque-os para outra sala antes de desativá-la.`,
        422,
        { requestId },
      );
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.schedule !== undefined) patch.schedule = input.schedule;
  if (input.position !== undefined) patch.position = input.position;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (Object.keys(patch).length === 0) return fail("unprocessable_entity", "Nada para alterar.", 422, { requestId });

  const { data, error } = await supabase
    .from("calendar_rooms")
    .update(patch)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, organization_id, name, color, position, schedule, is_active")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe uma sala com este nome.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) return fail("not_found", "Sala não encontrada.", 404, { requestId });

  await audit({
    action: "calendar_room.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_room",
    resourceId: id,
    metadata: { campos: Object.keys(patch) },
    requestId,
  });

  return ok(data, { requestId });
}
