/**
 * POST /api/v1/rastreio/clique/[token] — registra o clique no botão do WhatsApp de uma
 * landing page (o script `public/rastreio.js` chama quando a pessoa clica).
 *
 * Por que existe: o Google não entrega identificador quando a pessoa chega ao WhatsApp. O
 * script põe um código curto (`ref:K7M2QX`) no texto do link e registra aqui o clique com
 * os parâmetros do anúncio; quando a mensagem chega com o código, a conversa é ligada ao
 * clique (`lib/atribuicao/ligar-clique.ts`). Ver `lib/atribuicao/clique-whatsapp.ts`.
 *
 * É uma rota PÚBLICA (o script roda em página de terceiros), então:
 * • o token do caminho — o mesmo da fonte de webhook — resolve a organização; nunca o corpo;
 * • limite de taxa por token e por IP;
 * • corpo pequeno, e só os parâmetros da allowlist são guardados (nunca o corpo cru);
 * • responde 204 sem corpo em qualquer caso aceito, inclusive repetição do mesmo código
 *   (sendBeacon pode reenviar) e clique sem sinal de anúncio — a rota não revela o que
 *   guardou nem se o código já existia.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { normalizaCodigo, parametrosDoClique, temSinalDeAnuncio } from "@/lib/atribuicao/clique-whatsapp";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

const POR_MINUTO_POR_TOKEN = 120;
const POR_MINUTO_POR_IP = 30;
/** Um clique real tem poucas centenas de bytes; o teto protege a rota aberta. */
const TAMANHO_MAXIMO = 8_000;

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 8) return fail("not_found", "unknown token", 404, { requestId });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "sem-ip";
  const [porToken, porIp] = await Promise.all([
    checkRateLimit(`rastreio_clique:${token}`, POR_MINUTO_POR_TOKEN, 60),
    checkRateLimit(`rastreio_clique_ip:${ip}`, POR_MINUTO_POR_IP, 60),
  ]);
  if (!porToken.allowed || !porIp.allowed) {
    return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const bruto = await req.text();
  if (bruto.length > TAMANHO_MAXIMO) return fail("invalid_request", "payload_too_large", 413, { requestId });

  const tipo = req.headers.get("content-type") ?? "";
  let corpo: Record<string, unknown>;
  if (tipo.includes("application/json")) {
    try {
      corpo = bruto ? (JSON.parse(bruto) as Record<string, unknown>) : {};
    } catch {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
  } else {
    // sendBeacon / fetch no-cors mandam texto ou formulário: sem pré-voo de CORS.
    corpo = Object.fromEntries(new URLSearchParams(bruto));
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return fail("invalid_request", "invalid_body", 400, { requestId });
  }

  const codigo = normalizaCodigo(corpo.codigo);
  if (!codigo) return fail("invalid_request", "invalid_code", 400, { requestId });

  const admin = createAdminClient();
  const { data: fonte, error: erroFonte } = await admin
    .from("webhook_sources")
    .select("organization_id, is_active")
    .eq("path_token", token)
    .maybeSingle();
  if (erroFonte) return fail("internal_error", "lookup_failed", 500, { requestId });
  if (!fonte || !fonte.is_active) return fail("not_found", "unknown token", 404, { requestId });

  const parametros = parametrosDoClique(corpo);
  // Clique sem nenhum sinal de anúncio (acesso direto) não tem o que atribuir.
  if (!temSinalDeAnuncio(parametros)) return new NextResponse(null, { status: 204 });

  const { error } = await admin.from("rastreio_cliques").insert({
    organization_id: fonte.organization_id,
    codigo,
    parametros,
    landing_url: parametros.landing_url ?? parametros.page_url ?? null,
    client_user_agent: parametros.client_user_agent ?? null,
  });
  // 23505: o mesmo código chegou duas vezes (o navegador reenviou) — o primeiro vale.
  if (error && error.code !== "23505") {
    logger.warn("rastreio: falha ao gravar clique do WhatsApp", {
      organization_id: fonte.organization_id,
      erro: error.message.slice(0, 200),
    });
    return fail("internal_error", "write_failed", 500, { requestId });
  }

  return new NextResponse(null, { status: 204 });
}
