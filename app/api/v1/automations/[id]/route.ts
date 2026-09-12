/** GET /api/v1/automations/[id] — detalhe + últimos envios (paginado). */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(
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
    .select(
      "id, name, trigger_kind, channel_session_id, template_name, template_language, variable_mapping, status, created_at, updated_at",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!automacao) return fail("not_found", "Automação não encontrada.", 404, { requestId });

  const { data: envios } = await admin
    .from("whatsapp_template_automation_sends")
    .select("id, lead_id, contact_id, status, external_id, error_message, sent_at")
    .eq("automation_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("sent_at", { ascending: false })
    .limit(PAGE_SIZE);

  return ok({ automation: automacao, recent_sends: envios ?? [] }, { requestId });
}
