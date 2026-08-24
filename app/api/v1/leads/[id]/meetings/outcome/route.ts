/**
 * POST /api/v1/leads/[id]/meetings/outcome — Fase 3 do dashboard (funil real).
 *
 * Fecha o ciclo aberto por `meetings/schedule`: compareceu ou não. Exige que
 * exista um `meeting_scheduled` prévio — sem isso "presença" não tem contra
 * o que ser medida, e o funil (agendados × compareceram) perderia coerência
 * se alguém pudesse registrar presença do nada. Carrega o `scheduled_at` do
 * agendamento mais recente no próprio payload do desfecho: o dashboard lê só
 * `meeting_outcome` para montar o funil, sem precisar correlacionar as duas
 * linhas por proximidade de data.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { meetingOutcomeSchema, MEETING_OUTCOME_LABELS } from "@/lib/schemas/leads";
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
  const parsed = meetingOutcomeSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Escolha um desfecho válido.", 422, {
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

  const { data: agendamento, error: agErr } = await supabase
    .from("crm_lead_activities")
    .select("payload")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("type", "meeting_scheduled")
    .order("performed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (agErr) return fail("internal_error", agErr.message, 500, { requestId });
  if (!agendamento) {
    return fail(
      "unprocessable_entity",
      "Nenhuma visita/reunião agendada para este negócio ainda.",
      422,
      { requestId },
    );
  }
  const scheduledAt = (agendamento.payload as { scheduled_at?: string })?.scheduled_at ?? null;

  const label = MEETING_OUTCOME_LABELS[parsed.data.outcome];
  const emitido = await emitLeadActivity(supabase, {
    organizationId: authz.org.orgId,
    leadId: lead.id,
    contactId: lead.contact_id,
    type: "meeting_outcome",
    sourceModule: "kanban.meeting_outcome_dialog",
    actor: { type: "user", id: authz.user.id },
    reason: label,
    payload: { outcome: parsed.data.outcome, scheduled_at: scheduledAt },
  });
  if (!emitido.ok) return fail("internal_error", emitido.error ?? "Falha ao registrar.", 500, { requestId });

  return ok({ registered: true }, { requestId });
}
