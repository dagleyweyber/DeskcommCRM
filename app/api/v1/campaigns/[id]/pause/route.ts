/** POST /api/v1/campaigns/[id]/pause — o despachante pula campanha `paused`. */
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
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: campanha } = await admin
    .from("whatsapp_campaigns")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });
  if (campanha.status !== "queued" && campanha.status !== "running") {
    return fail("invalid_request", `Não é possível pausar uma campanha ${campanha.status}.`, 422, {
      requestId,
    });
  }

  const { error } = await admin
    .from("whatsapp_campaigns")
    .update({ status: "paused" })
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "campaign.paused",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: id,
    requestId,
  });

  return ok({ status: "paused" }, { requestId });
}
