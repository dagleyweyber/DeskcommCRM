/**
 * POST /api/v1/webhooks/agenda/[token] — avisos de agendamento do Uno e do Zandu.
 *
 * O `token` do caminho resolve a conexão (e a organização) — nunca o corpo do aviso.
 * No Uno, o cabeçalho `X-UNO-Webhook-Token` também tem de bater com o token que o
 * CRM gerou (guardado como hash SHA-256); o Zandu não documenta assinatura, então
 * o segredo é o próprio endereço.
 *
 * Ordem: grava o aviso → responde. Processar vem logo em seguida, na mesma chamada,
 * mas o que importa para o Uno (1 tentativa, 10 s) é o aviso estar GRAVADO: se o
 * processamento falhar ou demorar, o cron reprocessa. Gravar falhou → 500, e o
 * aviso aparece como falha no log do sistema da clínica (de onde se reenvia).
 *
 * GET responde 200 — alguns painéis testam a URL antes de salvar.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { COLUNAS_INTEGRACAO, processarAviso, traduzirAviso } from "@/lib/agenda-externa/avisos";
import type { Integracao } from "@/lib/agenda-externa/sincronizar";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

/** Um lote grande no sistema da clínica gera 1 aviso por agendamento. */
const RATE_LIMIT_PER_MIN = 300;
const MAX_BYTES = 256 * 1024;

function mesmoHash(texto: string, hashHex: string): boolean {
  const a = createHash("sha256").update(texto).digest();
  const b = Buffer.from(hashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function conexaoDoToken(token: string): Promise<(Integracao & { inbound_secret_hash: string | null }) | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("calendar_integrations")
    .select(`${COLUNAS_INTEGRACAO}, inbound_secret_hash`)
    .eq("inbound_path_token", token)
    .in("provider", ["uno", "zandu"])
    .maybeSingle();
  return (data as (Integracao & { inbound_secret_hash: string | null }) | null) ?? null;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 16 || !(await conexaoDoToken(token))) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }
  return ok({ pronto: true }, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 16) return fail("not_found", "unknown webhook token", 404, { requestId });

  const rl = await checkRateLimit(`webhook_agenda:${token}`, RATE_LIMIT_PER_MIN, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const integ = await conexaoDoToken(token);
  if (!integ) return fail("not_found", "unknown webhook token", 404, { requestId });

  if (integ.provider === "uno") {
    const enviado = req.headers.get("x-uno-webhook-token")?.trim() ?? "";
    if (!integ.inbound_secret_hash || !enviado || !mesmoHash(enviado, integ.inbound_secret_hash)) {
      return fail("unauthenticated", "invalid_webhook_token", 401, { requestId });
    }
  }

  const bruto = await req.text();
  if (bruto.length > MAX_BYTES) return fail("invalid_request", "payload_too_large", 413, { requestId });
  let payload: unknown;
  try {
    payload = JSON.parse(bruto);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const aviso = traduzirAviso(integ.provider, payload);
  const admin = createAdminClient();
  const { data: gravado, error } = await admin
    .from("calendar_integration_events")
    .insert({
      organization_id: integ.organization_id,
      integration_id: integ.id,
      event_type: aviso.evento.slice(0, 80) || null,
      external_id: aviso.externalId,
      payload,
    })
    .select("id, payload, received_at, attempts")
    .single();
  if (error || !gravado) {
    logger.error("[agenda-externa] aviso não gravado", { organization_id: integ.organization_id, erro: error?.message });
    return fail("internal_error", "could_not_store", 500, { requestId });
  }

  // Gravado: daqui em diante nada se perde. Falha ao processar fica para o cron.
  const r = await processarAviso(admin, integ, gravado as { id: string; payload: unknown; received_at: string; attempts: number });
  return ok({ recebido: true, aplicado: r.aplicado }, { requestId });
}
