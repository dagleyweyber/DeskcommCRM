/**
 * POST /api/v1/integrations/belle/sincronizar — roda uma rodada agora (admin).
 *
 * É o botão "Sincronizar agora" da tela: quem acabou de conectar não precisa
 * esperar o scheduler (10 min) para ver o primeiro resultado — e quem mudou algo
 * no Belle confere na hora. Pode levar até ~1 min (o Belle é lento).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { PROVEDOR, sincronizarIntegracao, type Integracao } from "@/lib/agenda-externa/sincronizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: integ } = await admin
    .from("calendar_integrations")
    .select("id, organization_id, credential_encrypted, external_account_id, default_area_code, initial_sync_done_at, far_window_index")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (!integ) return fail("not_found", "O Belle não está conectado.", 404, { requestId });

  await audit({
    action: "calendar_integration.sync_requested",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_integrations",
    resourceId: integ.id as string,
    requestId,
  });

  const resultado = await sincronizarIntegracao(admin, integ as Integracao);
  return ok(resultado, { requestId });
}
