/**
 * Aplica no lead as tags de ORIGEM, CAMPANHA e ANÚNCIO que a atribuição dele merece.
 *
 * ─── Decisões que parecem estranhas e não são ───────────────────────────────
 * • NÃO EMITE `lead.tag_added`. Esse evento aciona automações ("quando o lead ganhar
 *   a tag X, mande a mensagem Y"). Tag automática de origem é classificação derivada
 *   da atribuição, não ação de alguém — emitir o evento faria uma automação já
 *   configurada disparar para cada lead que ganhasse `origem:meta-ads`, inclusive no
 *   preenchimento dos leads antigos. O registro do fato continua sendo
 *   `lead_touchpoints`, que a tela do lead mostra.
 * • PRIMEIRO TOQUE GANHA e nada é sobrescrito: a tag diz de onde o lead VEIO. Se o
 *   grupo já tem valor, é deixado como está — inclusive quando a pessoa o corrigiu à
 *   mão. Os toques seguintes continuam em `lead_touchpoints`.
 * • É chamada em mais de um momento (nascimento do lead e depois que a Meta devolve o
 *   nome da campanha) e é IDEMPOTENTE: quem chega primeiro põe a origem, quem chega
 *   depois acrescenta campanha e anúncio.
 * • NUNCA LANÇA. Como o registro de pontos de contato: perder o lead para guardar a
 *   origem dele seria trocar o principal pelo acessório.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { origensDoPonto, tagsDeOrigem, textosDasTags, type PontoParaTags } from "./tags-de-origem";
import { CANAL, type Canal } from "./ponto-de-contato";
import { lerTag, type GrupoChave } from "@/lib/tags/estruturadas";

interface LinhaDePonto {
  canal: string;
  utm_source: string | null;
  landing_url: string | null;
  referrer: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  ad_id: string | null;
}

export async function aplicarTagsDeOrigem(
  db: SupabaseClient,
  ids: { organizationId: string; leadId: string },
): Promise<{ aplicadas: string[] }> {
  try {
    const { data: lead, error: erroLead } = await db
      .from("crm_leads")
      .select("tags")
      .eq("id", ids.leadId)
      .eq("organization_id", ids.organizationId)
      .maybeSingle();
    if (erroLead) throw new Error(erroLead.message);
    if (!lead) return { aplicadas: [] };
    const atuais = ((lead as { tags: string[] | null }).tags ?? []) as string[];

    const { data: pontos, error: erroPontos } = await db
      .from("lead_touchpoints")
      .select("canal, utm_source, landing_url, referrer, campaign_name, ad_name, ad_id")
      .eq("organization_id", ids.organizationId)
      .eq("lead_id", ids.leadId)
      .order("occurred_at", { ascending: true })
      .limit(5);
    if (erroPontos) throw new Error(erroPontos.message);

    // Primeiro ponto que é mídia paga — `outro` não vira tag.
    const linha = ((pontos ?? []) as LinhaDePonto[]).find(
      (p) => origensDoPonto({ canal: p.canal as Canal, utmSource: p.utm_source, landingUrl: p.landing_url, referrer: p.referrer }).length > 0,
    );
    if (!linha) return { aplicadas: [] };

    const ponto: PontoParaTags = {
      canal: linha.canal as Canal,
      utmSource: linha.utm_source,
      landingUrl: linha.landing_url,
      referrer: linha.referrer,
      campaignName: linha.campaign_name,
      adName: linha.ad_name,
    };

    // Anúncio da Meta: o nome vem da consulta feita depois que o lead nasce.
    let nomes: { campaignName: string | null; adName: string | null } = { campaignName: null, adName: null };
    if (linha.canal === CANAL.META_ADS && linha.ad_id && (!ponto.campaignName || !ponto.adName)) {
      const { data: meta } = await db
        .from("meta_ads_ad_metadata")
        .select("campaign_name, ad_name")
        .eq("organization_id", ids.organizationId)
        .eq("ad_id", linha.ad_id)
        .maybeSingle();
      const m = meta as { campaign_name: string | null; ad_name: string | null } | null;
      if (m) nomes = { campaignName: m.campaign_name, adName: m.ad_name };
    }

    const desejadas = tagsDeOrigem(ponto, nomes);
    // Grupo que o lead já tem fica como está (primeiro toque ganha, correção manual vale).
    const gruposComValor = new Set<GrupoChave>(
      atuais.map((t) => lerTag(t)?.grupo).filter((g): g is GrupoChave => g !== undefined),
    );
    const novas = textosDasTags(desejadas.filter((t) => !gruposComValor.has(t.grupo)));
    // Dentro de um grupo ainda sem valor, duas tags iguais não entram.
    const unicas = [...new Set(novas)].filter((t) => !atuais.includes(t));
    if (unicas.length === 0) return { aplicadas: [] };

    const { error: erroUpdate } = await db
      .from("crm_leads")
      .update({ tags: [...atuais, ...unicas] })
      .eq("id", ids.leadId)
      .eq("organization_id", ids.organizationId);
    if (erroUpdate) throw new Error(erroUpdate.message);
    return { aplicadas: unicas };
  } catch (err) {
    logger.warn("atribuicao: falha ao aplicar tags de origem", {
      organization_id: ids.organizationId,
      lead_id: ids.leadId,
      erro: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { aplicadas: [] };
  }
}
