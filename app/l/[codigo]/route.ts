/**
 * GET /l/[codigo] — o botão de link escolhido na campanha (migration 0216).
 *
 * O modelo é aprovado com `<crm>/l/{{1}}`; cada campanha manda um código no
 * `{{1}}`. Aqui o clique é contado e a pessoa segue para o destino que o
 * operador colou — inclusive um grupo do WhatsApp, que a Meta não aceita
 * direto no botão.
 *
 * Rota PÚBLICA (quem clica é o paciente, sem sessão). Não é redirecionamento
 * aberto: o destino só existe se um gerente o gravou ao criar a campanha, e o
 * código não é adivinhável (`gerarCodigoDoLink`).
 *
 * `/l/exemplo` é o endereço que vai como exemplo na revisão da Meta: responde
 * uma página neutra em vez de 404, porque quem revisa pode abrir o link.
 */
import { NextResponse, type NextRequest } from "next/server";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ codigo: string }>;
}

function pagina(titulo: string, texto: string, status: number): NextResponse {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222"><h1 style="font-size:1.25rem">${titulo}</h1><p>${texto}</p></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { codigo } = await ctx.params;

  if (codigo === "exemplo") {
    return pagina("Link da campanha", "Este é o link de exemplo do botão. Em cada mensagem ele leva ao destino escolhido na campanha.", 200);
  }
  if (!/^[A-Za-z0-9]{8,32}$/.test(codigo)) {
    return pagina("Link inválido", "Este link não existe ou foi digitado errado.", 404);
  }

  const { data: destino, error } = await createAdminClient().rpc("fn_registrar_clique_do_link", {
    p_codigo: codigo,
  });
  if (error) {
    logger.warn("link da campanha: falha ao registrar clique", { erro: error.message.slice(0, 200) });
    return pagina("Link indisponível", "Não conseguimos abrir este link agora. Tente de novo em instantes.", 503);
  }
  if (typeof destino !== "string" || !/^https?:\/\//i.test(destino)) {
    return pagina("Link inválido", "Este link não existe ou já foi removido.", 404);
  }

  // 302 (não 301): o destino de um código pode ser corrigido, e o navegador não
  // pode guardar o caminho antigo para sempre.
  return NextResponse.redirect(destino, { status: 302, headers: { "cache-control": "no-store" } });
}
