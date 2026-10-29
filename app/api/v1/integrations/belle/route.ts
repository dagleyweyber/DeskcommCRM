/**
 * GET    /api/v1/integrations/belle — a conexão da org ativa, se houver (manager+).
 *        Lê da view `calendar_integrations_safe`, que nunca expõe o token cifrado.
 * POST   /api/v1/integrations/belle — conecta/troca o token (admin). O token é
 *        conferido no próprio Belle ANTES de gravar: token errado responde 422 na
 *        hora, em vez de virar uma conexão que falha em silêncio no scheduler.
 * DELETE /api/v1/integrations/belle — desconecta (admin). Os agendamentos já
 *        importados ficam na Agenda (são histórico); só param de atualizar.
 *
 * Modelo: app/api/v1/integrations/meta-ads/credentials/route.ts.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarClienteBelle, FalhaNoBelle, TokenBelleInvalido } from "@/lib/agenda-externa/belle/api";
import { dddDoTelefone } from "@/lib/agenda-externa/belle/traduzir";
import { PROVEDOR } from "@/lib/agenda-externa/sincronizar";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, credential_last4, external_account_id, external_account_name, default_area_code, status, last_error, last_sync_at, last_sync_stats, initial_sync_done_at, created_at, updated_at";

const connectSchema = z.object({
  token: z.string().trim().min(8).max(512),
  cod_estab: z.string().trim().min(1).max(40).optional(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calendar_integrations_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", authz.org.orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler a conexão com o Belle.", 500, { requestId });
  return ok(data ?? null, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = connectSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Cole o token de integração do Belle.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { token, cod_estab } = parsed.data;

  let estabelecimentos;
  try {
    estabelecimentos = await criarClienteBelle({ token, timeoutMs: 20_000 }).estabelecimentos();
  } catch (err) {
    if (err instanceof TokenBelleInvalido) {
      return fail("validation_failed", "O Belle recusou este token. Confira se copiou o token inteiro da tela de integrações.", 422, { requestId });
    }
    const motivo = err instanceof FalhaNoBelle ? err.message : "erro inesperado";
    return fail("upstream_unavailable", `Não foi possível falar com o Belle agora (${motivo}). Tente de novo em instantes.`, 502, { requestId });
  }
  if (estabelecimentos.length === 0) {
    return fail("validation_failed", "O Belle aceitou o token, mas não mostrou nenhuma unidade ativa.", 422, { requestId });
  }

  const unidade = cod_estab ? estabelecimentos.find((e) => e.codigo === cod_estab) : estabelecimentos.length === 1 ? estabelecimentos[0] : undefined;
  if (!unidade) {
    // Token que enxerga mais de uma unidade: a tela pergunta qual é a desta organização.
    return fail("state_conflict", "Escolha a unidade.", 409, {
      requestId,
      details: { unidades: estabelecimentos.map((e) => ({ codigo: e.codigo, nome: e.nomeFantasia })) },
    });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    return fail("internal_error", "Não foi possível cifrar o token (chave de criptografia do servidor ausente).", 500, { requestId });
  }

  const { data: anterior } = await admin
    .from("calendar_integrations")
    .select("id, external_account_id")
    .eq("organization_id", org.orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  // Trocar de UNIDADE recomeça a 1ª importação (silenciosa); trocar só o token, não.
  const recomeca = !anterior || anterior.external_account_id !== unidade.codigo;

  const { data: salvo, error } = await admin
    .from("calendar_integrations")
    .upsert(
      {
        organization_id: org.orgId,
        provider: PROVEDOR,
        credential_encrypted: cifrado,
        credential_last4: token.slice(-4),
        external_account_id: unidade.codigo,
        external_account_name: unidade.nomeFantasia || null,
        default_area_code: dddDoTelefone(unidade.telefone),
        status: "healthy",
        last_error: null,
        created_by_user_id: user.id,
        ...(recomeca ? { initial_sync_done_at: null, far_window_index: 0, last_sync_at: null, last_sync_stats: {} } : {}),
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();
  if (error || !salvo) return fail("internal_error", "Erro ao salvar a conexão com o Belle.", 500, { requestId });

  await audit({
    action: "calendar_integration.connected",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "calendar_integrations",
    resourceId: salvo.id as string,
    requestId,
    metadata: { provider: PROVEDOR, unidade: unidade.codigo, recomecou_importacao: recomeca },
  });

  const supabase = await createClient();
  const { data: seguro } = await supabase.from("calendar_integrations_safe").select(SAFE_COLUMNS).eq("id", salvo.id).maybeSingle();
  return ok(seguro, { status: 201, requestId });
}

export async function DELETE(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { error } = await admin
    .from("calendar_integrations")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("provider", PROVEDOR);
  if (error) return fail("internal_error", "Erro ao desconectar o Belle.", 500, { requestId });

  await audit({
    action: "calendar_integration.disconnected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_integrations",
    resourceId: null,
    requestId,
    metadata: { provider: PROVEDOR },
  });
  return ok({ disconnected: true }, { requestId });
}
