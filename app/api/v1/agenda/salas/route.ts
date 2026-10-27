/**
 * GET  /api/v1/agenda/salas — salas da clínica (agent+) + o horário padrão que
 *      herdam, pra grade desenhar uma coluna por sala com o "08–21h" do topo.
 * POST /api/v1/agenda/salas — cria uma sala (manager+, mesmo piso da RLS
 *      `calendar_rooms_write`, migration 0200).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { horarioPadraoDaClinica, lerHorario } from "@/lib/agenda/consulta";
import type { Sala } from "@/lib/agenda/tipos";
import { createSalaSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../_comum";

export const dynamic = "force-dynamic";

const COLUNAS = "id, organization_id, name, color, position, schedule, is_active";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_rooms" });
  if (!authz.ok) return authz.response;

  const incluirInativas = new URL(req.url).searchParams.get("incluir_inativas") === "true";

  let query = supabase
    .from("calendar_rooms")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (!incluirInativas) query = query.eq("is_active", true);

  const [{ data, error }, horarioPadrao] = await Promise.all([query, horarioPadraoDaClinica(supabase, authz.org.orgId)]);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const salas = ((data ?? []) as Sala[]).map((s) => ({ ...s, schedule: lerHorario(s.schedule) }));
  return ok({ salas, horario_padrao: horarioPadrao }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_rooms" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(createSalaSchema, req, requestId);
  if (!corpo.ok) return corpo.response;

  // Nova sala entra no FIM da lista.
  const { data: ultima } = await supabase
    .from("calendar_rooms")
    .select("position")
    .eq("organization_id", authz.org.orgId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = Number((ultima as { position?: number } | null)?.position ?? 0) + 1000;

  const { data, error } = await supabase
    .from("calendar_rooms")
    .insert({
      organization_id: authz.org.orgId,
      name: corpo.data.name,
      color: corpo.data.color ?? null,
      schedule: corpo.data.schedule ?? null,
      position,
    })
    .select(COLUNAS)
    .single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe uma sala com este nome.", 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "calendar_room.created",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_room",
    resourceId: (data as { id: string }).id,
    requestId,
  });

  return ok(data, { status: 201, requestId });
}
