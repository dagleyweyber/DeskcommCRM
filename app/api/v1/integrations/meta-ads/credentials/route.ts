/**
 * GET    /api/v1/integrations/meta-ads/credentials — a credencial da org
 *        ativa, se houver (manager+). Lê da view
 *        `tenant_meta_ads_credentials_safe`, que nunca expõe o token cifrado.
 * POST   /api/v1/integrations/meta-ads/credentials — conecta/atualiza
 *        (admin). Plaintext do access_token entra só aqui, cifrado com
 *        `fn_encrypt_oauth` (mesmo mecanismo de webhook secrets) e
 *        descartado. Upsert por organização — uma conexão por tenant.
 * DELETE /api/v1/integrations/meta-ads/credentials — desconecta (admin).
 *
 * Meta Ads, Fase C1. Modelo: app/api/v1/ai/credentials/route.ts.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Só usada pelo GET, que lê da VIEW tenant_meta_ads_credentials_safe (onde
// ads_read_connected já é computado) — o POST/DELETE leem a TABELA crua, sem
// essa coluna, e tratam o booleano à parte.
const SAFE_COLUMNS =
  "id, organization_id, dataset_id, status, last_error, created_at, updated_at, ads_read_connected";

const connectSchema = z.object({
  access_token: z.string().trim().min(8).max(2048),
  dataset_id: z.string().trim().min(1).max(60),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads_credentials" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenant_meta_ads_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao ler credencial do Meta Ads.", 500, { requestId });
  }
  return ok(data ?? null, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "meta_ads_credentials" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = connectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const admin = createAdminClient();

  const encrypted = await encryptWebhookSecret(admin, input.access_token);
  if (!encrypted) {
    return fail(
      "internal_error",
      "Não foi possível cifrar o token (chave de criptografia do servidor ausente).",
      500,
      { requestId },
    );
  }

  // Sem validação assíncrona contra a Graph API no v1 — o primeiro envio
  // real (venda marcada como ganha) já revela token/dataset_id inválido, e
  // fica registrado em meta_capi_send_log. 'healthy' otimista em vez de
  // 'connecting' preso pra sempre sem um passo que o resolva.
  // Select explícito com o bytea cifrado (não SAFE_COLUMNS, que é da VIEW) —
  // aqui é a tabela crua, e o próprio insert nunca sobrescreve o token de
  // leitura da Fase E (não está no objeto do upsert), então precisa ler de
  // volta pra saber o estado atual antes de virar o booleano seguro.
  const { data: upserted, error: upsertErr } = await admin
    .from("tenant_meta_ads_credentials")
    .upsert(
      {
        organization_id: activeOrg.orgId,
        access_token_encrypted: encrypted,
        dataset_id: input.dataset_id,
        status: "healthy",
        last_error: null,
      },
      { onConflict: "organization_id" },
    )
    .select(
      "id, organization_id, dataset_id, status, last_error, created_at, updated_at, ads_read_token_encrypted",
    )
    .single();

  if (upsertErr || !upserted) {
    return fail("internal_error", "Erro ao salvar credencial do Meta Ads.", 500, { requestId });
  }

  await audit({
    action: "meta_ads.credential_connected",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "tenant_meta_ads_credentials",
    resourceId: upserted.id,
    requestId,
    metadata: { dataset_id: input.dataset_id },
  });

  const { ads_read_token_encrypted, ...safeRow } = upserted;
  return ok(
    { ...safeRow, ads_read_connected: ads_read_token_encrypted != null },
    { status: 201, requestId },
  );
}

export async function DELETE(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "meta_ads_credentials" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_meta_ads_credentials")
    .delete()
    .eq("organization_id", activeOrg.orgId);

  if (error) {
    return fail("internal_error", "Erro ao desconectar o Meta Ads.", 500, { requestId });
  }

  await audit({
    action: "meta_ads.credential_disconnected",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "tenant_meta_ads_credentials",
    resourceId: null,
    requestId,
  });

  return ok({ disconnected: true }, { requestId });
}
