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
    .select("id, status, trigger_kind, event_type_id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!automacao) return fail("not_found", "Automação não encontrada.", 404, { requestId });
  if (automacao.status === "active") {
    return fail("invalid_request", "Esta automação já está ativa.", 422, { requestId });
  }

  // UMA automação ativa por serviço (migration 0199): duas ativas para o mesmo serviço mandariam
  // a mensagem em dobro. Confere ANTES, para dizer qual é e o que fazer; o índice único é a
  // trava final contra a corrida entre dois cliques.
  let consulta = admin
    .from("whatsapp_template_automations")
    .select("id, name")
    .eq("organization_id", authz.org.orgId)
    .eq("trigger_kind", automacao.trigger_kind as string)
    .eq("status", "active")
    .neq("id", id);
  consulta = automacao.event_type_id
    ? consulta.eq("event_type_id", automacao.event_type_id as string)
    : consulta.is("event_type_id", null);
  const { data: conflito } = await consulta.limit(1).maybeSingle();
  const frase = (nome: string) =>
    `Já existe uma automação ativa para ${automacao.event_type_id ? "este serviço" : "todos os serviços"}: "${nome}". Pause-a antes de ativar esta — duas ativas mandariam a mensagem em dobro.`;
  if (conflito) return fail("state_conflict", frase(conflito.name as string), 409, { requestId });

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
