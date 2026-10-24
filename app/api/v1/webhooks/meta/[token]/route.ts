/**
 * GET|POST /api/v1/webhooks/meta/[token] — webhook da WhatsApp Cloud API.
 *
 * `GET` é o handshake de verificação: a Meta só começa a entregar eventos depois
 * que o endpoint devolve `hub.challenge` **em texto puro**. Envelopar em
 * `{data:...}` (o wrapper padrão da nossa API) faz a verificação falhar com uma
 * mensagem inútil no dashboard — por isso esta é a única rota do repo que
 * responde texto cru, e está aqui escrito o motivo.
 *
 * `POST` verifica HMAC **SHA-256** com o App Secret, e só então age. O outro canal
 * do repo usa SHA-512 com segredo por sessão — não reaproveite a verificação dele;
 * o detalhe está em `lib/channels/meta/webhook.ts`.
 *
 * Por que ainda existe token no path se o App Secret é global: o segredo é do APP,
 * e um app serve N WABAs de N organizações. O token amarra o payload a UMA org
 * antes de qualquer escrita — sem ele, quem conhecesse o App Secret escreveria em
 * qualquer tenant.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { parseMetaWebhook, verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { processarEventosMeta } from "@/lib/channels/meta/process-events";
import { appSecretDoWebhook } from "@/lib/channels/meta/embedded-config";
import { metaSessionByWebhookToken } from "@/lib/channels/meta/session";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const session = await metaSessionByWebhookToken(token);
  if (!session) return new NextResponse("not found", { status: 404 });

  const challenge = verificationChallenge(
    req.nextUrl.searchParams,
    process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
  );
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });

  // Texto puro, sem wrapper — ver o cabeçalho.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const session = await metaSessionByWebhookToken(token);
  if (!session) return fail("not_found", "unknown webhook token", 404, { requestId });

  const rawBody = await req.text();
  // O segredo é o do APP dono da WABA: sessão em coexistência assina com o app do
  // Tech Provider, as manuais com o `META_APP_SECRET` de sempre (ver `appSecretDoWebhook`).
  const appSecret = appSecretDoWebhook(session.connectionMode);
  if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret)) {
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const eventos = parseMetaWebhook(envelope as Parameters<typeof parseMetaWebhook>[0]);
  const admin = createAdminClient();
  const desfechos = await processarEventosMeta({ admin, session, eventos, requestId });

  // 200 SEMPRE que a assinatura confere, inclusive para evento que não nos
  // interessa: a Meta re-entrega tudo que não recebe 2xx, e recusar o que
  // ignoramos vira re-tentativa em backoff por horas.
  // `outcomes` no corpo: quem depura vê o que aconteceu com cada evento em vez de
  // ler um contador que não distingue sucesso de falha.
  return NextResponse.json(
    { received: eventos.length, outcomes: desfechos },
    { status: 200 },
  );
}
