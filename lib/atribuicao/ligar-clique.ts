/**
 * Liga a conversa que acabou de chegar ao clique no botão do WhatsApp da landing page.
 *
 * A mensagem traz `ref:K7M2QX` (ver `clique-whatsapp.ts`); o clique correspondente foi
 * registrado pelo script da página em `rastreio_cliques`. Achado o par, os parâmetros do
 * anúncio (gclid, fbclid, UTMs, campanha…) viram ponto(s) de contato do lead — pelo mesmo
 * caminho de qualquer outra origem (`registrarPontosDeContato`), então as tags de origem,
 * o envio de conversões e o dossiê funcionam sem saber que veio de um link de WhatsApp.
 *
 * Decisões que não são óbvias:
 * • O CLIQUE É CONSUMIDO ANTES de virar ponto de contato (update condicionado a
 *   `usado_em is null`). Duas mensagens com o mesmo código, ou o mesmo evento entregue
 *   duas vezes, não duplicam a atribuição: só quem consumir primeiro registra.
 * • Código de outra organização não casa: a busca filtra `organization_id` (service role
 *   não tem RLS) — a organização vem da conversa, nunca da mensagem.
 * • Clique velho demais (`VALIDADE_DO_CLIQUE_DIAS`) não liga: depois de semanas, o código
 *   num texto colado ou reenviado não é mais "o clique que trouxe esta conversa".
 * • NUNCA LANÇA. Atribuição descreve de onde o lead veio; perder a mensagem ou o lead para
 *   guardá-la seria trocar o principal pelo acessório.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { CAMPO_PRIMEIRO_CONTATO, VIA, pontosDaLandingPage } from "./ponto-de-contato";
import { VALIDADE_DO_CLIQUE_DIAS, extraiCodigoDaMensagem } from "./clique-whatsapp";
import { registrarPontosDeContato } from "./registrar";

interface LinhaDoClique {
  id: string;
  parametros: Record<string, unknown> | null;
  created_at: string;
  usado_em: string | null;
}

export async function ligarCliqueAoLead(
  db: SupabaseClient,
  ids: { organizationId: string; leadId: string; contactId: string | null },
  texto: string | null | undefined,
): Promise<{ ligado: boolean }> {
  const codigo = extraiCodigoDaMensagem(texto);
  if (!codigo) return { ligado: false };

  try {
    const { data: clique, error } = await db
      .from("rastreio_cliques")
      .select("id, parametros, created_at, usado_em")
      .eq("organization_id", ids.organizationId)
      .eq("codigo", codigo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const c = clique as LinhaDoClique | null;
    if (!c || c.usado_em) return { ligado: false };

    const idadeMs = Date.now() - new Date(c.created_at).getTime();
    if (!Number.isFinite(idadeMs) || idadeMs > VALIDADE_DO_CLIQUE_DIAS * 24 * 60 * 60 * 1000) return { ligado: false };

    // Consome ANTES de registrar: quem consumir primeiro é quem registra.
    const { data: consumido, error: erroConsumo } = await db
      .from("rastreio_cliques")
      .update({ usado_em: new Date().toISOString(), lead_id: ids.leadId })
      .eq("id", c.id)
      .eq("organization_id", ids.organizationId)
      .is("usado_em", null)
      .select("id");
    if (erroConsumo) throw new Error(erroConsumo.message);
    if (!Array.isArray(consumido) || consumido.length === 0) return { ligado: false };

    const parametros = c.parametros ?? {};
    const pontos = pontosDaLandingPage(parametros, parametros[CAMPO_PRIMEIRO_CONTATO]).map((p) => ({
      ...p,
      via: VIA.LINK_WHATSAPP,
    }));
    if (pontos.length === 0) return { ligado: false };

    await registrarPontosDeContato(db, ids, pontos);
    return { ligado: true };
  } catch (err) {
    logger.warn("atribuicao: falha ao ligar a conversa ao clique do WhatsApp", {
      organization_id: ids.organizationId,
      lead_id: ids.leadId,
      erro: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { ligado: false };
  }
}
