/** POST /api/v1/automations/[id]/pause — sai de `active` pra `paused`. */
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
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!automacao) return fail("not_found", "Automação não encontrada.", 404, { requestId });
  if (automacao.status !== "active") {
    return fail("invalid_request", `Não é possível pausar uma automação ${automacao.status}.`, 422, {
      requestId,
    });
  }

  const { error } = await admin
    .from("whatsapp_template_automations")
    .update({ status: "paused" })
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "automation.paused",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_template_automation",
    resourceId: id,
    requestId,
  });

  return ok({ status: "paused" }, { requestId });
}
