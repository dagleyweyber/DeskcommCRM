/**
 * POST /api/v1/leads/[id]/meetings/schedule — Fase 3 do dashboard (funil real).
 *
 * Registra "este negócio tem uma visita/reunião marcada para X" como uma
 * linha em `crm_lead_activities` (type='meeting_scheduled'), mesmo padrão de
 * `objections/route.ts`. Reagendar É emitir de novo — cada chamada é um
 * evento novo, não um update: a data anterior fica no histórico em vez de
 * ser sobrescrita, e é exatamente esse histórico que o dashboard soma.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { scheduleMeetingSchema } from "@/lib/schemas/leads";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }
  const parsed = scheduleMeetingSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Informe uma data/hora válida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Negócio não encontrado.", 404, { requestId });

  const quando = new Date(parsed.data.scheduled_at).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const emitido = await emitLeadActivity(supabase, {
    organizationId: authz.org.orgId,
    leadId: lead.id,
    contactId: lead.contact_id,
    type: "meeting_scheduled",
    sourceModule: "kanban.schedule_meeting_dialog",
    actor: { type: "user", id: authz.user.id },
    reason: `Visita/reunião agendada para ${quando}`,
    payload: { scheduled_at: parsed.data.scheduled_at },
  });
  if (!emitido.ok) return fail("internal_error", emitido.error ?? "Falha ao registrar.", 500, { requestId });

  return ok({ registered: true, scheduled_at: parsed.data.scheduled_at }, { requestId });
}
