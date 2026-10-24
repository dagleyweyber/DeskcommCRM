/**
 * GET  /api/v1/channels/official/embedded — o modo "Conectar com a Meta" existe aqui?
 * POST /api/v1/channels/official/embedded — conclui o Embedded Signup (coexistência).
 *
 * O GET devolve `appId` e `configId` em RUNTIME, por resposta de API, e não por
 * `NEXT_PUBLIC_*`: variável pública é fixada no build, e a imagem genérica do
 * self-host é construída uma vez para todo mundo (ver `lib/api/public-base.ts`).
 * Instalação sem as três variáveis responde `enabled:false` — caso normal, não erro.
 *
 * O POST NÃO confia no que o browser mandou. O popup entrega `code`, `waba_id` e
 * `phone_number_id` pelo `postMessage`, e quem controla o browser controla esses
 * IDs. A rota troca o code por token e então pergunta à Meta (`debug_token`) a quem o
 * token dá acesso: só aceita uma WABA que o token cobre, do NOSSO app, com um número
 * que de fato responde por esse token. Valida antes de gravar, como o caminho manual.
 *
 * Coexistência NÃO registra o número (`/register` o tiraria do app do celular) e
 * exige `is_on_biz_app` — sem isso o cliente escolheu outro fluxo e a sessão nasceria
 * num estado que esta fase não sabe operar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { publicBase } from "@/lib/api/public-base";
import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { ativarCoexistencia } from "@/lib/channels/meta/embedded-activate";
import { embeddedSignupConfig } from "@/lib/channels/meta/embedded-config";
import {
  exchangeEmbeddedCode,
  infoDoNumero,
  numerosDoAppNaWaba,
  wabaIdsDoToken,
} from "@/lib/channels/meta/embedded-signup";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const concluirSchema = z.object({
  code: z.string().min(10),
  waba_id: z.string().min(5),
  // Opcional: o evento de término da coexistência documenta só a WABA. Quando vem,
  // é conferido contra o que a Meta diz; quando não vem, a rota descobre o número.
  phone_number_id: z.string().min(5).optional(),
});

type Gate = { ok: true; orgId: string; userId: string } | { ok: false; resposta: NextResponse };

async function adminGate(requestId: string): Promise<Gate> {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return { ok: false, resposta: fail("forbidden", "admin_required", 403, { requestId }) };
  }
  return { ok: true, orgId: org.orgId, userId: user.id };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const cfg = embeddedSignupConfig();
  // O verify token é exigido pelo `override_callback_uri`: sem ele a assinatura da
  // WABA nunca verificaria. Instalação sem ele não mostra o botão.
  const pronto = Boolean(cfg && process.env.META_WEBHOOK_VERIFY_TOKEN);
  return ok(pronto && cfg ? { enabled: true, appId: cfg.appId, configId: cfg.configId } : { enabled: false });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const cfg = embeddedSignupConfig();
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const appSecret = process.env.META_EMBEDDED_APP_SECRET?.trim();
  if (!cfg || !verifyToken || !appSecret) {
    return fail("not_found", "embedded_signup_indisponivel", 404, { requestId });
  }

  const parsed = concluirSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "code e waba_id são obrigatórios", 422, {
      requestId,
    });
  }
  const { code, waba_id } = parsed.data;

  // 1. code → token (o code vale 30s; esta é a primeira coisa que a rota faz).
  const troca = await exchangeEmbeddedCode({ code, appId: cfg.appId, appSecret });
  if (!troca.ok) {
    return fail("invalid_request", `A Meta recusou o código de autorização: ${troca.motivo}`, 422, {
      requestId,
    });
  }

  // 2. a quem o token dá acesso — a verdade vem da Meta, não do browser.
  const alcance = await wabaIdsDoToken({ token: troca.token, appId: cfg.appId, appSecret });
  if (!alcance.ok) {
    return fail("invalid_request", `Não consegui validar o token com a Meta: ${alcance.motivo}`, 422, {
      requestId,
    });
  }
  if (alcance.appIdDoToken !== cfg.appId || !alcance.wabaIds.includes(waba_id)) {
    logger.warn("embedded-signup: token não cobre a WABA informada", {
      request_id: requestId,
      waba_id,
      cobre: alcance.wabaIds,
    });
    return fail("forbidden", "waba_nao_autorizada_pelo_token", 403, { requestId });
  }

  // 3. qual número: o informado, conferido; ou o único da WABA que está no app.
  let phone_number_id = parsed.data.phone_number_id;
  const doApp = await numerosDoAppNaWaba({ wabaId: waba_id, token: troca.token });
  if (!doApp.ok) {
    return fail("invalid_request", `Não consegui listar os números da conta: ${doApp.motivo}`, 422, {
      requestId,
    });
  }
  if (phone_number_id ? !doApp.phoneNumberIds.includes(phone_number_id) : doApp.phoneNumberIds.length !== 1) {
    return fail(
      "invalid_request",
      doApp.phoneNumberIds.length === 0
        ? "Nenhum número desta conta está no app WhatsApp Business. Escolha, no popup da Meta, a opção de conectar o número que você já usa no app do celular."
        : "Não consegui determinar qual número conectar. Conecte um número por vez.",
      422,
      { requestId },
    );
  }
  phone_number_id = phone_number_id ?? doApp.phoneNumberIds[0]!;

  // 3b. o número responde por esse token e está no app WhatsApp Business.
  const numero = await infoDoNumero({ phoneNumberId: phone_number_id, token: troca.token });
  if (!numero.ok) {
    return fail("invalid_request", `A Meta não reconheceu o número: ${numero.motivo}`, 422, {
      requestId,
    });
  }
  if (!numero.info.isOnBizApp) {
    return fail(
      "invalid_request",
      "Este número não está no app WhatsApp Business. Escolha, no popup da Meta, a opção de conectar o número que você já usa no app do celular.",
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();

  // O mesmo número em OUTRA organização: o índice único (migration 0194) já barraria
  // o insert, mas com um erro de banco. Aqui o operador recebe a explicação.
  const { data: emUso } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("meta_phone_number_id", phone_number_id)
    .is(ARCHIVED_AT, null)
    .maybeSingle();
  if (emUso && emUso.organization_id !== g.orgId) {
    return fail("state_conflict", "numero_ja_conectado_em_outra_organizacao", 409, { requestId });
  }

  const cifrado = await encryptWebhookSecret(admin, troca.token);
  if (!cifrado) {
    return fail(
      "invalid_request",
      "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      422,
      { requestId },
    );
  }

  // Mesma busca do caminho manual: NÃO filtra `archived_at`, porque canal excluído é
  // o que reconectar precisa ressuscitar (senão nasce uma segunda linha na org).
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", g.orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}`),
    () => buscarExistente("id"),
  );
  const existente = existenteRaw as { id: string; archived_at?: string | null } | null;

  const telefone = numero.info.displayPhoneNumber
    ? `+${numero.info.displayPhoneNumber.replace(/\D/g, "")}`
    : null;
  const linha = {
    organization_id: g.orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phone_number_id,
    meta_waba_id: waba_id,
    meta_app_id: cfg.appId,
    meta_token_encrypted: cifrado,
    phone_number: telefone,
    display_name: numero.info.verifiedName ?? "Canal oficial",
    status: "WORKING",
    meta_connection_mode: "embedded_coexistence",
    meta_onboarded_at: new Date().toISOString(),
  };

  const { error } = existente
    ? await reactivateChannelSession(
        admin,
        {
          organizationId: g.orgId,
          channelSessionId: existente.id,
          archivedAt: existente.archived_at ?? null,
        },
        linha,
        {
          userId: g.userId,
          requestId,
          metadata: { provider: CHANNEL_PROVIDER_META, phone_number: telefone, modo: "embedded_coexistence" },
        },
      )
    : await admin.from("channel_sessions").insert({ ...linha, webhook_secret_encrypted: cifrado });
  if (error) {
    return fail("internal_error", error.message ?? "channel_session_write_failed", 500, { requestId });
  }

  // 4. a URL de webhook da sessão só existe depois da gravação (o token do caminho
  // nasce no banco, e a reativação o rotaciona). Lê de volta e assina a WABA.
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token")
    .eq("organization_id", g.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .is(ARCHIVED_AT, null)
    .maybeSingle();
  if (!sessao) {
    return fail("internal_error", "channel_session_not_found_after_write", 500, { requestId });
  }

  // 4+5. Recebimento e depois agenda/histórico — mesma sequência da reativação
  // (`ativarCoexistencia`). O histórico vale UMA vez e só nas 24h do onboarding, então
  // só é pedido com o recebimento já de pé.
  const ativacao = await ativarCoexistencia({
    wabaId: waba_id,
    phoneNumberId: phone_number_id,
    token: troca.token,
    callbackUri: `${publicBase(req)}/api/v1/webhooks/meta/${sessao.webhook_path_token}`,
    verifyToken,
  });
  if (!ativacao.ok) {
    // A sessão fica gravada, mas SEM receber. Marcar como falha impede a tela de dizer
    // "conectado" para um canal que não ouve o cliente; a tela oferece "Reativar".
    await admin
      .from("channel_sessions")
      .update({ status: "FAILED" })
      .eq("id", sessao.id)
      .eq("organization_id", g.orgId);
    logger.warn("embedded-signup: assinatura da WABA falhou", {
      request_id: requestId,
      waba_id,
      motivo: ativacao.motivo,
    });
    return fail(
      "external_dependency_failed",
      `Número conectado, mas não consegui ativar o recebimento de mensagens: ${ativacao.motivo}. Use "Reativar recebimento" na tela de Conexões.`,
      424,
      { requestId },
    );
  }
  const sync = ativacao.sync;
  for (const [tipo, r] of Object.entries(sync)) {
    if (!r.ok) {
      logger.warn("embedded-signup: pedido de sincronização falhou", {
        request_id: requestId,
        tipo,
        motivo: r.motivo,
      });
    }
  }

  return ok({
    connected: true,
    sync,
    displayName: linha.display_name,
    phoneNumber: telefone,
    mode: "embedded_coexistence",
  });
}
