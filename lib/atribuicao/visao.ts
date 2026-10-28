/**
 * A atribuição do lead como a TELA a lê — pontos de contato com os nomes de
 * campanha / conjunto / anúncio já resolvidos.
 *
 * Os nomes da Meta vêm de `meta_ads_ad_metadata` (resolvidos pela API a partir do
 * ad_id, `lib/meta-ads/hierarchy-handler.ts`) e têm precedência sobre o que veio na
 * URL: o nome na URL é o que o anúncio tinha no dia do clique (ou uma UTM digitada à
 * mão), o da API é o nome atual de verdade. O que a API não resolveu (sem token de
 * leitura, Google) fica com o da URL.
 *
 * Arquivo sem I/O: importado pela rota e pelo componente.
 */

export interface PontoDeContatoVisao {
  id: string;
  canal: string;
  via: string;
  occurred_at: string;
  click_id_type: string | null;
  tem_clique: boolean;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  keyword: string | null;
  landing_url: string | null;
  ad_headline: string | null;
}

export interface AtribuicaoDoLead {
  /** Em ordem cronológica — o primeiro é o primeiro toque, o último é o último. */
  pontos: PontoDeContatoVisao[];
}

export interface LinhaDoPontoDeContato {
  id: string;
  canal: string;
  via: string;
  occurred_at: string;
  click_id_type: string | null;
  click_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  keyword: string | null;
  landing_url: string | null;
  extras: Record<string, unknown> | null;
}

export interface HierarquiaDaMeta {
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

export function montaAtribuicao(
  linhas: readonly LinhaDoPontoDeContato[],
  hierarquias: readonly HierarquiaDaMeta[],
): AtribuicaoDoLead {
  const porAnuncio = new Map(hierarquias.map((h) => [h.ad_id, h]));
  const pontos = [...linhas]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((l): PontoDeContatoVisao => {
      const h = l.canal === "meta_ads" && l.ad_id ? porAnuncio.get(l.ad_id) : undefined;
      const headline = l.extras && typeof l.extras.ad_headline === "string" ? l.extras.ad_headline : null;
      return {
        id: l.id,
        canal: l.canal,
        via: l.via,
        occurred_at: l.occurred_at,
        click_id_type: l.click_id_type,
        // O identificador em si não vai para a tela: é dado de envio (CAPI/Google),
        // não de leitura humana. A tela só precisa saber se existe.
        tem_clique: !!l.click_id,
        utm_source: l.utm_source,
        utm_medium: l.utm_medium,
        utm_campaign: l.utm_campaign,
        campaign_id: h?.campaign_id ?? l.campaign_id,
        campaign_name: h?.campaign_name ?? l.campaign_name,
        adset_id: h?.adset_id ?? l.adset_id,
        adset_name: h?.adset_name ?? l.adset_name,
        ad_id: l.ad_id,
        ad_name: h?.ad_name ?? l.ad_name,
        keyword: l.keyword,
        landing_url: l.landing_url,
        ad_headline: headline,
      };
    });
  return { pontos };
}
