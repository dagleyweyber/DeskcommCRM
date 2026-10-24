/**
 * POST /api/v1/channels/official/embedded/reativar — refaz a ativação de uma conexão
 * em coexistência que ficou pela metade.
 *
 * Nasceu da primeira conexão real: a Meta recusou o endereço de recebimento, a rota de
 * conclusão parou, e o canal ficou gravado mas surdo — sem os pedidos de histórico e
 * agenda, que valem UMA vez e só nas 24h seguintes ao onboarding. Reconectar do zero
 * pediria um novo QR code ao cliente e gastaria a janela; aqui o token já está
 * guardado, então só repetimos a sequência (`ativarCoexistencia`).
 *
 * Só atua na sessão ATIVA da organização do chamador e só em modo coexistência: o
 * token vem do banco, nunca do corpo, e a organização vem da sessão autenticada.
 * Reassinar uma WABA já assinada é idempotente; um pedido de histórico repetido a Meta
 * recusa, e isso volta no resultado sem derrubar nada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { publicBase } from "@/lib/api/public-base";
import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ARCHIVED_AT } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { metaCredsForPhoneNumberId } from "@/lib/channels/meta/credentials";
import { ativarCoexistencia } from "@/lib/channels/meta/embedded-activate";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) return fail("not_found", "embedded_signup_indisponivel", 404, { requestId });

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token, meta_waba_id, meta_phone_number_id")
    .eq("organization_id", org.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .eq("meta_connection_mode", "embedded_coexistence")
    .is(ARCHIVED_AT, null)
    .maybeSingle();
  if (!sessao || !sessao.meta_waba_id || !sessao.meta_phone_number_id) {
    return fail("not_found", "sem_conexao_em_coexistencia", 404, { requestId });
  }

  const creds = await metaCredsForPhoneNumberId(admin, sessao.meta_phone_number_id);
  if (!creds || creds.source !== "session") {
    return fail("state_conflict", "token_da_sessao_indisponivel", 409, { requestId });
  }

  const ativacao = await ativarCoexistencia({
    wabaId: sessao.meta_waba_id,
    phoneNumberId: sessao.meta_phone_number_id,
    token: creds.token,
    callbackUri: `${publicBase(req)}/api/v1/webhooks/meta/${sessao.webhook_path_token}`,
    verifyToken,
  });
  if (!ativacao.ok) {
    logger.warn("embedded-signup: reativação falhou", {
      request_id: requestId,
      waba_id: sessao.meta_waba_id,
      motivo: ativacao.motivo,
    });
    return fail(
      "external_dependency_failed",
      `Não consegui ativar o recebimento de mensagens: ${ativacao.motivo}`,
      424,
      { requestId },
    );
  }

  // Recebimento de pé: o canal pode voltar a constar como funcionando.
  await admin
    .from("channel_sessions")
    .update({ status: "WORKING" })
    .eq("id", sessao.id)
    .eq("organization_id", org.orgId);

  return ok({ reactivated: true, sync: ativacao.sync });
}
