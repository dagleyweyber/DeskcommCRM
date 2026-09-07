/**
 * POST /api/v1/campaigns/[id]/cancel — encerra de vez. Todo destinatário
 * ainda `pending` vira `skipped`, pra ficar claro (na tela e no relatório)
 * que ele NUNCA recebeu a mensagem — não confundir com `sent`/`failed`.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CANCELAVEL = ["draft", "queued", "running", "paused"];

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
  if (!CANCELAVEL.includes(campanha.status)) {
    return fail("invalid_request", `Campanha ${campanha.status} não pode ser cancelada.`, 422, {
      requestId,
    });
  }

  const { error: erroDestinatarios } = await admin
    .from("whatsapp_campaign_recipients")
    .update({ status: "skipped" })
    .eq("campaign_id", id)
    .eq("status", "pending");
  if (erroDestinatarios) return fail("internal_error", erroDestinatarios.message, 500, { requestId });

  const { error } = await admin
    .from("whatsapp_campaigns")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "campaign.cancelled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: id,
    requestId,
  });

  return ok({ status: "cancelled" }, { requestId });
}
