/**
 * POST /api/v1/automations/[id]/activate — sai de `draft`/`paused` pra
 * `active`. Não dispara nada aqui: o cron
 * `template-automations-dispatch` é quem avalia quem está devido, no
 * tick seguinte — mesmo desenho de `campaigns/[id]/start`.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { acharConflitoDeAtivacao, fraseDoConflito } from "@/lib/automations/configuracao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: automacao } = await admin
    .from("whatsapp_template_automations")
    .select("id, status, trigger_kind, event_type_id, timing_kind, timing_value")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .is("archived_at", null)
    .maybeSingle();
  if (!automacao) return fail("not_found", "Automação não encontrada.", 404, { requestId });
  if (automacao.status === "active") {
    return fail("invalid_request", "Esta automação já está ativa.", 422, { requestId });
  }

  // UMA automação ativa por serviço E momento de envio (migrations 0199 → 0201): duas ativas
  // para o mesmo serviço no mesmo momento mandariam a mensagem em dobro — já "confirmação 1 dia
  // antes" + "lembrete no dia" do mesmo serviço convivem. Confere ANTES, para dizer qual é e o que fazer; o índice único é a
  // trava final contra a corrida entre dois cliques.
  const frase = (nome: string) => fraseDoConflito(Boolean(automacao.event_type_id), nome);
  const conflito = await acharConflitoDeAtivacao(admin, authz.org.orgId, {
    id,
    trigger_kind: automacao.trigger_kind as string,
    event_type_id: (automacao.event_type_id as string | null) ?? null,
    timing_kind: automacao.timing_kind as string,
    timing_value: (automacao.timing_value as number | null) ?? null,
  });
  if (conflito) return fail("state_conflict", frase(conflito.name), 409, { requestId });

  const { error } = await admin
    .from("whatsapp_template_automations")
    .update({ status: "active" })
    .eq("id", id);
  if (error) {
    // Corrida: outra ativação passou entre a conferência e o update — o índice único barrou.
    if (error.code === "23505") return fail("state_conflict", frase("outra automação"), 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "automation.activated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_template_automation",
    resourceId: id,
    requestId,
  });

  return ok({ status: "active" }, { requestId });
}
