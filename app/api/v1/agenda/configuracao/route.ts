/**
 * GET /api/v1/agenda/configuracao — horário de funcionamento padrão da clínica.
 * PUT /api/v1/agenda/configuracao — salva (manager+). As salas sem horário
 *     próprio herdam este (migration 0200, `calendar_settings`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { horarioPadraoDaClinica } from "@/lib/agenda/consulta";
import { configuracaoDaAgendaSchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

import { lerCorpo } from "../_comum";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_settings" });
  if (!authz.ok) return authz.response;

  const horario = await horarioPadraoDaClinica(supabase, authz.org.orgId);
  return ok({ default_schedule: horario }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_settings" });
  if (!authz.ok) return authz.response;

  const corpo = await lerCorpo(configuracaoDaAgendaSchema, req, requestId);
  if (!corpo.ok) return corpo.response;

  const { error } = await supabase
    .from("calendar_settings")
    .upsert(
      { organization_id: authz.org.orgId, default_schedule: corpo.data.default_schedule },
      { onConflict: "organization_id" },
    );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "calendar_settings.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_settings",
    resourceId: authz.org.orgId,
    requestId,
  });

  return ok({ default_schedule: corpo.data.default_schedule }, { requestId });
}
