/**
 * GET|POST /api/v1/webhooks/meta — o endereço PADRÃO do app Tech Provider.
 *
 * A Meta tem UM endereço de webhook por app e um `override_callback_uri` por conta
 * (WABA). O override leva as mensagens, ecos, histórico e agenda ao endereço da sessão
 * (`/api/v1/webhooks/meta/[token]`) — mas NÃO admite override para `account_update`
 * (desconexão, banimento, restrição) nem para status de modelo: esses chegam sempre
 * aqui, sem o token de caminho que identifica a clínica.
 *
 * ─── Como a clínica é achada sem confiar no corpo ──────────────────────────
 * 1. A assinatura HMAC com o App Secret do app Tech Provider vem PRIMEIRO. Antes dela,
 *    o corpo é só bytes.
 * 2. Com a origem provada, a WABA do evento escolhe a sessão — e só entre sessões que o
 *    CRM já tem, em coexistência e ativas. WABA desconhecida é ignorada (200: a Meta
 *    re-entrega o que não recebe 2xx).
 *
 * Sem este endereço, uma clínica em coexistência que fosse desconectada pelo celular
 * (celular parado, número trocado) ficava "Conectado" na tela e deixava de receber.
 *
 * Por que GET também: é o handshake que a Meta faz ao salvar o endereço no painel.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { appSecretDoWebhook } from "@/lib/channels/meta/embedded-config";
import { processarEventosMeta } from "@/lib/channels/meta/process-events";
import { metaSessionByWabaOrPhone } from "@/lib/channels/meta/session";
import {
  parseMetaWebhook,
  verificationChallenge,
  verifyMetaSignature,
  type MetaWebhookEvent,
} from "@/lib/channels/meta/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const challenge = verificationChallenge(
    req.nextUrl.searchParams,
    process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
  );
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  // Texto puro, sem wrapper — a Meta só passa a entregar eventos depois disso.
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/** A chave de agrupamento: a conta; sem ela (recusa de histórico), o número. */
function chaveDoEvento(e: MetaWebhookEvent): string | null {
  if (e.wabaId) return `waba:${e.wabaId}`;
  if ("phoneNumberId" in e && e.phoneNumberId) return `pn:${e.phoneNumberId}`;
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const rawBody = await req.text();

  // O app deste endereço é o Tech Provider: o segredo é o do modo coexistência.
  const appSecret = appSecretDoWebhook("embedded_coexistence");
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

  // Agrupa por conta para resolver cada sessão uma vez, e processa cada grupo com o
  // mesmo código do endereço por canal.
  const grupos = new Map<string, MetaWebhookEvent[]>();
  for (const e of eventos) {
    const chave = chaveDoEvento(e);
    if (!chave) continue;
    const lista = grupos.get(chave) ?? [];
    lista.push(e);
    grupos.set(chave, lista);
  }

  const desfechos: string[] = [];
  for (const [chave, lista] of grupos) {
    const [tipo, valor] = [chave.slice(0, chave.indexOf(":")), chave.slice(chave.indexOf(":") + 1)];
    const session = await metaSessionByWabaOrPhone(
      tipo === "waba" ? { wabaId: valor } : { phoneNumberId: valor },
    );
    if (!session) {
      desfechos.push(`${chave}:sessao_desconhecida`);
      continue;
    }
    desfechos.push(...(await processarEventosMeta({ admin, session, eventos: lista, requestId })));
  }

  // 200 sempre que a assinatura confere: recusar o que ignoramos vira re-tentativa em
  // backoff por horas. Os desfechos no corpo dizem o que aconteceu com cada evento.
  return NextResponse.json({ received: eventos.length, outcomes: desfechos }, { status: 200 });
}
