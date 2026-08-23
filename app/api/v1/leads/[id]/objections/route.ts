/**
 * POST /api/v1/leads/[id]/objections — registra uma objeção com o negócio
 * ainda ABERTO (preço, "vou pensar", comparando concorrente...). Diferente
 * de `lost_reason`: aquele só existe no desfecho terminal; isto é sinal
 * durante o funil, sem fechar nada.
 *
 * Vira uma linha em `crm_lead_activities` (type='objection') via o mesmo
 * emissor compartilhado (`emitLeadActivity`) que `stage_changed`/`note`
 * já usam — não um insert próprio. `payload.code` carrega o vocabulário
 * fechado (CANONICAL_OBJECTIONS); `reason` carrega a frase legível (o que
 * a timeline mostra), nunca o código cru.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { objectionSchema, OBJECTION_LABELS } from "@/lib/schemas/leads";
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
  const parsed = objectionSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Escolha um motivo de objeção válido.", 422, {
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

  const label = OBJECTION_LABELS[parsed.data.reason] ?? parsed.data.reason;
  const emitido = await emitLeadActivity(supabase, {
    organizationId: authz.org.orgId,
    leadId: lead.id,
    contactId: lead.contact_id,
    type: "objection",
    sourceModule: "kanban.objection_dialog",
    actor: { type: "user", id: authz.user.id },
    reason: parsed.data.note ? `${label} — ${parsed.data.note}` : label,
    payload: { code: parsed.data.reason },
  });
  if (!emitido.ok) return fail("internal_error", emitido.error ?? "Falha ao registrar.", 500, { requestId });

  return ok({ registered: true }, { requestId });
}
