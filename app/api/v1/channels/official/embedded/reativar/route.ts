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
 *
 * Com mais de um número em coexistência, o corpo diz QUAL (`channel_session_id`) — o id só
 * escolhe entre as sessões desta organização, nunca alcança outra. Sem o id e com um número
 * só, reativa esse; sem o id e com vários, recusa em vez de adivinhar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

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

const corpoSchema = z.object({ channel_session_id: z.string().uuid().optional() });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) return fail("not_found", "embedded_signup_indisponivel", 404, { requestId });

  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("invalid_request", "channel_session_id_invalido", 422, { requestId });

  const admin = createAdminClient();
  let consulta = admin
    .from("channel_sessions")
    .select("id, webhook_path_token, meta_waba_id, meta_phone_number_id")
    .eq("organization_id", org.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .eq("meta_connection_mode", "embedded_coexistence")
    .is(ARCHIVED_AT, null);
  if (corpo.data.channel_session_id) consulta = consulta.eq("id", corpo.data.channel_session_id);
  const { data: candidatas } = await consulta.limit(2);
  if ((candidatas ?? []).length > 1) {
    return fail(
      "invalid_request",
      "Esta organização tem mais de um número em coexistência. Diga qual reativar (channel_session_id).",
      422,
      { requestId },
    );
  }
  const sessao = candidatas?.[0];
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
