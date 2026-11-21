/**
 * /api/v1/integrations/agenda/[provedor] — conexão com Uno ou Zandu (os sistemas que AVISAM).
 * O Belle tem a rota própria (/api/v1/integrations/belle): ele é relido, não avisa.
 *
 * GET    (manager+) a conexão, os números dos avisos e — só para admin — o caminho do
 *        endereço que recebe os avisos.
 * POST   (admin) conecta. Zandu: o token é conferido no próprio Zandu ANTES de gravar.
 *        Uno: não pede credencial; o CRM gera o token que se cola no Uno e o mostra UMA
 *        vez (guarda só o hash). `{ novo_endereco: true }` troca endereço e token.
 * DELETE (admin) desconecta. Os agendamentos já importados ficam na Agenda.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarClienteZandu, FalhaNoZandu, TokenZanduInvalido } from "@/lib/agenda-externa/zandu/api";
import { nomeDoProvedor } from "@/lib/agenda-externa/provedor";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const PROVEDORES_POR_AVISO = ["uno", "zandu"] as const;
type ProvedorPorAviso = (typeof PROVEDORES_POR_AVISO)[number];

interface RouteCtx {
  params: Promise<{ provedor: string }>;
}

const connectSchema = z.object({
  token: z.string().trim().min(8).max(2048).optional(),
  novo_endereco: z.boolean().optional(),
});

const COLUNAS =
  "id, provider, credential_last4, external_account_id, external_account_name, status, last_error, last_sync_at, last_sync_stats, initial_sync_done_at, created_at, inbound_path_token";

function provedorDe(valor: string): ProvedorPorAviso | null {
  return (PROVEDORES_POR_AVISO as readonly string[]).includes(valor) ? (valor as ProvedorPorAviso) : null;
}

const novoSegredo = (bytes: number) => randomBytes(bytes).toString("base64url");

async function resumoDosAvisos(admin: ReturnType<typeof createAdminClient>, orgId: string, integracaoId: string) {
  const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
  const base = () =>
    admin
      .from("calendar_integration_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("integration_id", integracaoId);
  const [{ count: recebidos }, { count: pendentes }, { data: ultimo }] = await Promise.all([
    base().gte("received_at", desde),
    base().is("processed_at", null),
    admin
      .from("calendar_integration_events")
      .select("received_at")
      .eq("organization_id", orgId)
      .eq("integration_id", integracaoId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    recebidos_24h: recebidos ?? 0,
    pendentes: pendentes ?? 0,
    ultimo_recebido_em: (ultimo?.received_at as string | undefined) ?? null,
  };
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const provedor = provedorDe((await ctx.params).provedor);
  if (!provedor) return fail("not_found", "Sistema desconhecido.", 404, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;

  // Service role: o caminho do endereço não está na view segura. Filtro de org manual.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_integrations")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("provider", provedor)
    .maybeSingle();
  if (error) return fail("internal_error", `Erro ao ler a conexão com o ${nomeDoProvedor(provedor)}.`, 500, { requestId });
  if (!data) return ok(null, { requestId });

  const { inbound_path_token, ...conexao } = data as typeof data & { inbound_path_token: string | null };
  const ehAdmin = authz.org.role === "admin";
  return ok(
    {
      ...conexao,
      caminho_do_aviso: ehAdmin && inbound_path_token ? `/api/v1/webhooks/agenda/${inbound_path_token}` : null,
      avisos: await resumoDosAvisos(admin, authz.org.orgId, data.id as string),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const provedor = provedorDe((await ctx.params).provedor);
  if (!provedor) return fail("not_found", "Sistema desconhecido.", 404, { requestId });
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const nome = nomeDoProvedor(provedor);

  let raw: unknown = {};
  try {
    const texto = await req.text();
    raw = texto ? JSON.parse(texto) : {};
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = connectSchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  const { token, novo_endereco } = parsed.data;

  const admin = createAdminClient();
  const { data: anterior } = await admin
    .from("calendar_integrations")
    .select("id, inbound_path_token, inbound_secret_hash, credential_encrypted")
    .eq("organization_id", org.orgId)
    .eq("provider", provedor)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    organization_id: org.orgId,
    provider: provedor,
    status: "healthy",
    last_error: null,
    created_by_user_id: user.id,
  };

  if (provedor === "zandu") {
    if (!token && !anterior?.credential_encrypted) {
      return fail("validation_failed", "Cole o token do Zandu (Conta > Dispositivos e API).", 422, { requestId });
    }
    if (token) {
      try {
        await criarClienteZandu({ token, timeoutMs: 15_000 }).conferirToken();
      } catch (err) {
        if (err instanceof TokenZanduInvalido) {
          return fail("validation_failed", "O Zandu recusou este token. Confira se copiou o token inteiro.", 422, { requestId });
        }
        const motivo = err instanceof FalhaNoZandu ? err.message : "erro inesperado";
        return fail("upstream_unavailable", `Não foi possível falar com o Zandu agora (${motivo}). Tente de novo em instantes.`, 502, { requestId });
      }
      const cifrado = await encryptWebhookSecret(admin, token);
      if (!cifrado) return fail("internal_error", "Não foi possível cifrar o token (chave de criptografia do servidor ausente).", 500, { requestId });
      patch.credential_encrypted = cifrado;
      patch.credential_last4 = token.slice(-4);
    }
  }

  const trocar = novo_endereco || !anterior?.inbound_path_token;
  if (trocar) patch.inbound_path_token = novoSegredo(24);
  // Token do Uno: gerado aqui, mostrado uma vez, guardado só como hash.
  let tokenDoUno: string | null = null;
  if (provedor === "uno" && (trocar || !anterior?.inbound_secret_hash)) {
    tokenDoUno = novoSegredo(24);
    patch.inbound_secret_hash = createHash("sha256").update(tokenDoUno).digest("hex");
  }

  const { data: salvo, error } = await admin
    .from("calendar_integrations")
    .upsert(patch, { onConflict: "organization_id,provider" })
    .select("id, inbound_path_token")
    .single();
  if (error || !salvo) return fail("internal_error", `Erro ao salvar a conexão com o ${nome}.`, 500, { requestId });

  await audit({
    action: "calendar_integration.connected",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "calendar_integrations",
    resourceId: salvo.id as string,
    requestId,
    metadata: { provider: provedor, novo_endereco: trocar, trocou_token: Boolean(token) },
  });

  return ok(
    {
      id: salvo.id,
      caminho_do_aviso: `/api/v1/webhooks/agenda/${salvo.inbound_path_token as string}`,
      // Só nesta resposta. Depois, só gerando outro.
      token_do_uno: tokenDoUno,
    },
    { status: 201, requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const provedor = provedorDe((await ctx.params).provedor);
  if (!provedor) return fail("not_found", "Sistema desconhecido.", 404, { requestId });
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { error } = await admin
    .from("calendar_integrations")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("provider", provedor);
  if (error) return fail("internal_error", `Erro ao desconectar o ${nomeDoProvedor(provedor)}.`, 500, { requestId });

  await audit({
    action: "calendar_integration.disconnected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_integrations",
    resourceId: null,
    requestId,
    metadata: { provider: provedor },
  });
  return ok({ disconnected: true }, { requestId });
}
