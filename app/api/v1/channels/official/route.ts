/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { publicBase } from "@/lib/api/public-base";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";
import { gravarSessaoOficial } from "@/lib/channels/meta/gravar-sessao";
import { registerMetaPhoneNumber } from "@/lib/channels/meta/register-number";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  phone_number_id: z.string().min(5),
  waba_id: z.string().min(5),
  token: z.string().min(20),
  // Opcional: canal já funciona pra texto/botão sem ele. Só bloqueia quem
  // tenta subir imagem de cabeçalho de template (Resumable Upload API
  // exige `/{app_id}/uploads`) — ver migration 0172.
  app_id: z.string().min(5).optional(),
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  //
  // Uma organização pode ter VÁRIOS números oficiais (Recepção e Comercial, por exemplo).
  // `numbers` traz todos; os campos de topo seguem descrevendo o primeiro, para quem
  // já consome esta resposta não quebrar. Antes era `maybeSingle`: com dois números a
  // consulta dava erro e a tela dizia "não conectado" para uma org com dois canais no ar.
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_waba_id, meta_app_id, meta_connection_mode, meta_token_encrypted, phone_number, display_name, webhook_path_token, status")
      .eq("organization_id", g.orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true });
  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null),
    () => consultar(),
  );

  const base = publicBase(req);
  const numbers = ((data ?? []) as LinhaOficialLida[]).map((linha) => descreverNumero(linha, base));
  const primeiro = numbers[0];
  return ok({
    connected: numbers.length > 0,
    hasToken: primeiro?.hasToken ?? false,
    phoneNumberId: primeiro?.phoneNumberId ?? null,
    wabaId: primeiro?.wabaId ?? null,
    appId: primeiro?.appId ?? null,
    connectionMode: primeiro?.connectionMode ?? null,
    displayName: primeiro?.displayName ?? null,
    phoneNumber: primeiro?.phoneNumber ?? null,
    status: primeiro?.status ?? null,
    webhook: primeiro?.webhook ?? null,
    numbers,
  });
}

interface LinhaOficialLida {
  id: string;
  meta_phone_number_id: string | null;
  meta_waba_id: string | null;
  meta_app_id: string | null;
  meta_connection_mode: string | null;
  meta_token_encrypted: string | null;
  phone_number: string | null;
  display_name: string | null;
  webhook_path_token: string;
  status: string | null;
}

function descreverNumero(data: LinhaOficialLida, base: string) {
  return {
    channelSessionId: data.id,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data.meta_token_encrypted),
    phoneNumberId: data.meta_phone_number_id,
    wabaId: data.meta_waba_id,
    appId: data.meta_app_id,
    /** `byo` (token colado) ou `embedded_coexistence` (popup da Meta, app do celular mantido). */
    connectionMode: data.meta_connection_mode,
    displayName: data.display_name,
    phoneNumber: data.phone_number,
    status: data.status,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    // Coexistência assina a WABA com `override_callback_uri` no servidor: não há o que
    // o operador colar no painel da Meta.
    webhook:
      data.meta_connection_mode !== "embedded_coexistence"
        ? {
            callbackUrl: `${base}/api/v1/webhooks/meta/${data.webhook_path_token}`,
            verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? null,
            fields: ["messages", "message_template_status_update", "template_category_update"],
          }
        : null,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "phone_number_id, waba_id e token são obrigatórios", 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token, app_id } = parsed.data;

  // Número conectado por COEXISTÊNCIA não pode ser sobrescrito por credencial
  // manual: o passo de registro logo abaixo (`/register`) tira o número do app
  // WhatsApp Business do celular — exatamente o que a coexistência existe para
  // evitar. Trocar de modo é decisão consciente (excluir o canal e reconectar),
  // não efeito colateral de colar um token. Vale só para ESTE número: outro número
  // da organização em coexistência não impede conectar um número novo.
  const { data: coexistente } = await createAdminClient()
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", g.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .eq("meta_phone_number_id", phone_number_id)
    .eq("meta_connection_mode", "embedded_coexistence")
    .is(ARCHIVED_AT, null)
    .maybeSingle();
  if (coexistente) {
    return fail(
      "state_conflict",
      "Este número foi conectado pelo modo Coexistência. Exclua o canal antes de conectar com credencial manual — registrar o número tiraria ele do app WhatsApp Business do celular.",
      409,
      { requestId },
    );
  }

  // VALIDA ANTES DE GRAVAR — a rota não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde.
  const validacao = await validateMetaCredentials({ phoneNumberId: phone_number_id, token });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.motivo, 422, { requestId });
  }

  // Achado ao vivo: número conectado por aqui (em vez do assistente "Início
  // rápido" da Meta, que chama isto por trás) fica com `status: PENDING` e
  // toda mensagem enviada volta `133010 Account not registered` — mesmo com
  // credencial válida e WABA aprovada. Chamar de novo num número já
  // registrado é seguro (idempotente do lado da Meta); por isso não bloqueia
  // a conexão se falhar — a credencial já provou que é válida.
  const registro = await registerMetaPhoneNumber({ phoneNumberId: phone_number_id, token });
  if (!registro.ok) {
    logger.warn("canal-oficial: registro do número na Cloud API falhou", {
      request_id: requestId,
      phone_number_id,
      motivo: registro.motivo,
    });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return fail(
      "invalid_request",
      "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      422,
      { requestId },
    );
  }

  const linha = {
    organization_id: g.orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phone_number_id,
    meta_waba_id: waba_id,
    // Só entra no patch quando preenchido — reconectar (trocar token) sem
    // digitar o App ID de novo não pode apagar o que já estava salvo.
    ...(app_id ? { meta_app_id: app_id } : {}),
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
    meta_connection_mode: "byo",
  };

  // Reconectar o MESMO número troca a credencial (ou ressuscita a linha dele); número
  // diferente nasce em linha própria e não mexe nos outros. Ver `gravarSessaoOficial`.
  const gravacao = await gravarSessaoOficial(admin, {
    linha,
    segredoCifrado: cifrado,
    ator: {
      userId: g.userId,
      requestId,
      metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
    },
  });
  if (!gravacao.ok) {
    return fail("internal_error", gravacao.motivo, 500, { requestId });
  }

  return ok({
    connected: true,
    channelSessionId: gravacao.channelSessionId,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    numberRegistered: registro.ok,
  });
}
