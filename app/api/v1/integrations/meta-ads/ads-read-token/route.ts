/**
 * POST   /api/v1/integrations/meta-ads/ads-read-token — conecta/atualiza o
 *        token de LEITURA de campanha/conjunto/anúncio (admin). INDEPENDENTE
 *        do token de Purchase (POST .../meta-ads/credentials): o token do
 *        Gerenciador de Eventos só tem `read_ads_dataset_quality`, não
 *        `ads_read`/`ads_management`. Exige que a credencial principal já
 *        exista (conecta a org ao Meta Ads antes de ler campanha).
 * DELETE /api/v1/integrations/meta-ads/ads-read-token — desconecta só a
 *        leitura (admin) — o Purchase automático continua funcionando.
 *
 * Meta Ads, Fase E2.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createAdminClient } from "@/lib/supabase/admin";

const connectSchema = z.object({
  ads_read_token: z.string().trim().min(8).max(2048),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "meta_ads_ads_read_token" });
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

  const admin = createAdminClient();

  const encrypted = await encryptWebhookSecret(admin, parsed.data.ads_read_token);
  if (!encrypted) {
    return fail(
      "internal_error",
      "Não foi possível cifrar o token (chave de criptografia do servidor ausente).",
      500,
      { requestId },
    );
  }

  // Exige credencial principal já existente (conectar Meta Ads primeiro) —
  // update, não upsert: sem linha, é sinal de fluxo fora de ordem.
  const { data: updated, error: updateErr } = await admin
    .from("tenant_meta_ads_credentials")
    .update({ ads_read_token_encrypted: encrypted })
    .eq("organization_id", activeOrg.orgId)
    .select("id")
    .maybeSingle();

  if (updateErr) {
    return fail("internal_error", "Erro ao salvar o token de leitura.", 500, { requestId });
  }
  if (!updated) {
    return fail(
      "validation_failed",
      "Conecte o Meta Ads (token de Purchase) antes de adicionar o token de leitura.",
      422,
      { requestId },
    );
  }

  await audit({
    action: "meta_ads.ads_read_token_connected",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "tenant_meta_ads_credentials",
    resourceId: updated.id,
    requestId,
  });

  return ok({ connected: true }, { requestId });
}

export async function DELETE(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "meta_ads_ads_read_token" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_meta_ads_credentials")
    .update({ ads_read_token_encrypted: null })
    .eq("organization_id", activeOrg.orgId);

  if (error) {
    return fail("internal_error", "Erro ao desconectar o token de leitura.", 500, { requestId });
  }

  await audit({
    action: "meta_ads.ads_read_token_disconnected",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "tenant_meta_ads_credentials",
    resourceId: null,
    requestId,
  });

  return ok({ disconnected: true }, { requestId });
}
