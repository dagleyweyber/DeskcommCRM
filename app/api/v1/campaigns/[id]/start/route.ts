/**
 * POST /api/v1/campaigns/[id]/start — sai de `draft`/`paused` pra `queued`.
 * Não dispara nada aqui: o cron `campaign-dispatch` é quem manda a primeira
 * mensagem, no tick seguinte.
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
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: campanha } = await admin
    .from("whatsapp_campaigns")
    .select("id, status, started_at")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });
  if (campanha.status !== "draft" && campanha.status !== "paused") {
    return fail("invalid_request", `Não é possível iniciar uma campanha ${campanha.status}.`, 422, {
      requestId,
    });
  }

  const { error } = await admin
    .from("whatsapp_campaigns")
    .update({
      status: "queued",
      // `started_at` só na PRIMEIRA vez — retomar de `paused` não reinicia a
      // contagem de quando a campanha começou.
      ...(campanha.started_at ? {} : { started_at: new Date().toISOString() }),
    })
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "campaign.started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: id,
    requestId,
  });

  return ok({ status: "queued" }, { requestId });
}
