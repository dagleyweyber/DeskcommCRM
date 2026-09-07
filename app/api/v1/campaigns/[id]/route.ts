/**
 * GET /api/v1/campaigns/[id] — detalhe + uma página de destinatários.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: campanha } = await admin
    .from("whatsapp_campaigns")
    .select(
      "id, name, status, channel_session_id, template_name, template_language, variable_mapping, audience_filter, total_recipients, sent_count, failed_count, created_at, started_at, completed_at",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });

  const pagina = Math.max(0, Number(req.nextUrl.searchParams.get("page") ?? "0"));
  const { data: destinatarios } = await admin
    .from("whatsapp_campaign_recipients")
    .select("id, contact_id, lead_id, status, external_id, error_message, sent_at")
    .eq("campaign_id", id)
    .order("created_at", { ascending: true })
    .range(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE - 1);

  return ok(
    { campaign: campanha, recipients: destinatarios ?? [], page: pagina, pageSize: PAGE_SIZE },
    { requestId },
  );
}
