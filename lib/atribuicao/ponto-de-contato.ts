/**
 * Ponto de contato — DE ONDE um lead veio, em campos estruturados.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * Medido em produção (2026-10-27, 90 dias): 611 de 630 leads de anúncio do
 * WhatsApp tinham o anúncio identificado, mas os 19 leads de landing page não
 * tinham NENHUM dado de origem — nem UTM, nem clique, nem campanha. A pergunta
 * "de qual campanha, conjunto e anúncio esse lead veio?" só tinha resposta para
 * um dos dois caminhos de entrada.
 *
 * E mesmo onde havia resposta, ela morava em `crm_leads.source_metadata` (JSON
 * solto, sobrescrito quando o lead é reaberto por um clique novo). Atribuição
 * vira linha própria em `lead_touchpoints` (migration 0202): um lead pode ter
 * vários pontos de contato (primeiro e último toque), cada um com canal, clique,
 * UTMs e os IDs de campanha/conjunto/anúncio — o que relatório, Kanban e envio de
 * conversão (Meta, Google) leem sem adivinhar chave de JSON.
 *
 * Este arquivo é PURO (sem I/O): recebe o que chegou e devolve o ponto de
 * contato. Quem grava é `registrar.ts`.
 *
 * ─── De onde vêm os IDs ─────────────────────────────────────────────────────
 * O link do anúncio carrega os IDs reais quando a URL de destino tem os
 * parâmetros dinâmicos da plataforma (o guia está na tela do webhook):
 *   Meta:   campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}
 *   Google: campaign_id={campaignid}&adgroup_id={adgroupid}&creative={creative}&keyword={keyword}
 * Também aceita IDs postos nas UTMs (utm_campaign numérico = id da campanha),
 * que é como muita conta já está configurada.
 *
 * O id do anúncio do Google vai em `creative`, NUNCA em `ad_id`: `ad_id` em
 * `source_metadata` dispara a resolução de nomes pela API da Meta
 * (`lib/meta-ads/hierarchy-handler.ts`), que com um id do Google só gravaria erro.
 */

/** Canal de mídia. Vocabulário aberto (`text` sem CHECK) — use as constantes, nunca literal. */
export const CANAL = {
  META_ADS: "meta_ads",
  GOOGLE_ADS: "google_ads",
  TIKTOK_ADS: "tiktok_ads",
  OUTRO: "outro",
} as const;
export type Canal = (typeof CANAL)[keyof typeof CANAL];

/** Por onde o ponto de contato foi capturado. */
export const VIA = {
  ANUNCIO_WHATSAPP: "anuncio_whatsapp",
  LANDING_PAGE: "landing_page",
  /** Clicou no botão do WhatsApp de uma landing page; a conversa foi ligada ao clique pelo código `ref:` (migration 0203). */
  LINK_WHATSAPP: "link_whatsapp",
  HISTORICO: "historico",
} as const;
export type Via = (typeof VIA)[keyof typeof VIA];

export const ROTULO_DO_CANAL: Readonly<Record<string, string>> = {
  [CANAL.META_ADS]: "Meta Ads",
  [CANAL.GOOGLE_ADS]: "Google Ads",
  [CANAL.TIKTOK_ADS]: "TikTok Ads",
  [CANAL.OUTRO]: "Outra origem",
};

export interface PontoDeContato {
  canal: Canal;
  via: Via;
  clickIdType: "ctwa_clid" | "fbclid" | "gclid" | "gbraid" | "wbraid" | "ttclid" | null;
  clickId: string | null;
  fbc: string | null;
  fbp: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  keyword: string | null;
  landingUrl: string | null;
  referrer: string | null;
  clientUserAgent: string | null;
  /** ISO-8601 — quando o clique/visita aconteceu (null = agora). */
  occurredAt: string | null;
  extras: Record<string, string>;
}

/**
 * Todas as chaves de atribuição que uma landing page pode mandar. Vão para
 * `source_metadata` (não para `custom_fields`) no webhook de captação.
 */
export const CHAVES_DE_ATRIBUICAO = [
  "fbclid",
  "fbc",
  "fbp",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "campaign_id",
  "adset_id",
  "ad_id",
  "adgroup_id",
  "creative",
  "keyword",
  "campaign_name",
  "adset_name",
  "ad_name",
  "gad_source",
  "gad_campaignid",
  "landing_url",
  "page_url",
  "referrer",
  "client_user_agent",
] as const;

/** Campo reservado do script de rastreamento: o PRIMEIRO toque, em JSON. */
export const CAMPO_PRIMEIRO_CONTATO = "dc_primeiro_contato";

const LIMITE = 1000;

/**
 * Valor utilizável, ou null. Descarta o parâmetro dinâmico NÃO substituído — quando
 * o anúncio é aberto fora do fluxo normal (pré-visualização, link copiado do
 * gerenciador), a URL chega com `{{ad.id}}` ou `{campaignid}` literais, e gravar
 * isso como id faria o relatório agrupar leads num "anúncio" que não existe.
 */
export function valorLimpo(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s || /[{}]/.test(s)) return null;
  return s.slice(0, LIMITE);
}

/** Id numérico de plataforma de anúncio (Meta e Google usam inteiros longos). */
function pareceId(s: string | null): s is string {
  return !!s && /^\d{6,}$/.test(s);
}

const ORIGENS_META = new Set(["facebook", "fb", "meta", "instagram", "ig", "an", "msg", "messenger", "facebook_ads", "meta_ads"]);
const ORIGENS_GOOGLE = new Set(["google", "googleads", "google_ads", "adwords", "gads", "youtube"]);
const ORIGENS_TIKTOK = new Set(["tiktok", "tiktok_ads", "tt"]);

function canalDe(d: Record<string, string | null>): Canal | null {
  if (d.gclid || d.gbraid || d.wbraid || d.gad_source || d.gad_campaignid) return CANAL.GOOGLE_ADS;
  if (d.fbclid || d.fbc) return CANAL.META_ADS;
  if (d.ttclid) return CANAL.TIKTOK_ADS;
  const origem = d.utm_source?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
  if (origem) {
    if (ORIGENS_GOOGLE.has(origem)) return CANAL.GOOGLE_ADS;
    if (ORIGENS_META.has(origem)) return CANAL.META_ADS;
    if (ORIGENS_TIKTOK.has(origem)) return CANAL.TIKTOK_ADS;
    return CANAL.OUTRO;
  }
  if (d.campaign_id || d.adset_id || d.ad_id || d.adgroup_id || d.creative) return CANAL.OUTRO;
  return null;
}

function clicDe(d: Record<string, string | null>): Pick<PontoDeContato, "clickIdType" | "clickId"> {
  for (const tipo of ["gclid", "gbraid", "wbraid", "fbclid", "ttclid"] as const) {
    const valor = d[tipo];
    if (valor) return { clickIdType: tipo, clickId: valor };
  }
  return { clickIdType: null, clickId: null };
}

/**
 * Ponto de contato a partir dos parâmetros de uma visita de landing page (o que o
 * script de rastreamento manda junto com o formulário). `null` quando não há
 * nenhum sinal de origem — visita direta não vira ponto de contato inventado.
 */
export function pontoDeContatoDaVisita(
  entrada: Record<string, unknown>,
  opts: { occurredAt?: string | null } = {},
): PontoDeContato | null {
  const d: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(entrada)) d[k.toLowerCase()] = valorLimpo(v);

  const canal = canalDe(d);
  if (!canal) return null;

  const google = canal === CANAL.GOOGLE_ADS;
  const utmCampaign = d.utm_campaign ?? null;
  const utmContent = d.utm_content ?? null;
  const utmTerm = d.utm_term ?? null;

  const campaignId = d.campaign_id ?? d.gad_campaignid ?? (pareceId(utmCampaign) ? utmCampaign : null);
  const adsetId = d.adset_id ?? d.adgroup_id ?? (!google && pareceId(utmTerm) ? utmTerm : null);
  const adId = google
    ? (d.creative ?? d.ad_id ?? null)
    : (d.ad_id ?? (pareceId(utmContent) ? utmContent : null));

  const campaignName = d.campaign_name ?? (utmCampaign && !pareceId(utmCampaign) ? utmCampaign : null);
  const adsetName = d.adset_name ?? (!google && utmTerm && !pareceId(utmTerm) ? utmTerm : null);
  const adName = d.ad_name ?? (!google && utmContent && !pareceId(utmContent) ? utmContent : null);
  const keyword = d.keyword ?? (google && utmTerm && !pareceId(utmTerm) ? utmTerm : null);

  const { clickIdType, clickId } = clicDe(d);
  const occurredAt = opts.occurredAt ?? null;

  // `fbc` é o cookie do Pixel; sem ele, a Meta aceita o montado a partir do
  // fbclid — `fb.1.<milissegundos do clique>.<fbclid>` (o script já monta no
  // navegador, com a hora real do clique; aqui é a reserva do servidor).
  let fbc = d.fbc ?? null;
  if (!fbc && d.fbclid) {
    const ms = occurredAt ? Date.parse(occurredAt) : Date.now();
    fbc = `fb.1.${Number.isFinite(ms) ? ms : Date.now()}.${d.fbclid}`;
  }

  const extras: Record<string, string> = {};
  if (d.gad_source) extras.gad_source = d.gad_source;

  return {
    canal,
    via: VIA.LANDING_PAGE,
    clickIdType,
    clickId,
    fbc,
    fbp: d.fbp ?? null,
    utmSource: d.utm_source ?? null,
    utmMedium: d.utm_medium ?? null,
    utmCampaign,
    utmContent,
    utmTerm,
    campaignId,
    adsetId,
    adId,
    campaignName,
    adsetName,
    adName,
    keyword,
    landingUrl: d.landing_url ?? d.page_url ?? null,
    referrer: d.referrer ?? null,
    clientUserAgent: d.client_user_agent ?? null,
    occurredAt,
    extras,
  };
}

/**
 * Os pontos de contato de um envio de landing page: o ÚLTIMO toque (os campos
 * soltos do formulário) e, se diferente, o PRIMEIRO (o JSON que o script guarda
 * desde a primeira visita). Ordem cronológica: primeiro, depois último.
 */
export function pontosDaLandingPage(
  campos: Record<string, unknown>,
  primeiroContatoJson: unknown,
): PontoDeContato[] {
  const ultimo = pontoDeContatoDaVisita(campos);

  let primeiro: PontoDeContato | null = null;
  if (typeof primeiroContatoJson === "string" && primeiroContatoJson.trim()) {
    try {
      const obj = JSON.parse(primeiroContatoJson) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const ts = valorLimpo(obj.ts);
        const quando = ts && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : null;
        primeiro = pontoDeContatoDaVisita(obj, { occurredAt: quando });
      }
    } catch {
      // JSON quebrado vindo do navegador: fica só com o último toque.
    }
  }

  if (primeiro && ultimo && mesmoToque(primeiro, ultimo)) return [ultimo];
  return [primeiro, ultimo].filter((p): p is PontoDeContato => p !== null);
}

function mesmoToque(a: PontoDeContato, b: PontoDeContato): boolean {
  return (
    a.canal === b.canal &&
    a.clickId === b.clickId &&
    a.campaignId === b.campaignId &&
    a.adsetId === b.adsetId &&
    a.adId === b.adId &&
    a.utmSource === b.utmSource &&
    a.utmCampaign === b.utmCampaign &&
    a.utmContent === b.utmContent
  );
}

/** Ponto de contato de um clique em anúncio "Clique para o WhatsApp". */
export function pontoDoAnuncioWhatsApp(ref: {
  clickId?: string | null;
  sourceId?: string | null;
  headline?: string | null;
  sourceUrl?: string | null;
}): PontoDeContato | null {
  const clickId = valorLimpo(ref.clickId);
  const adId = valorLimpo(ref.sourceId);
  if (!clickId && !adId) return null;
  const extras: Record<string, string> = {};
  const headline = valorLimpo(ref.headline);
  if (headline) extras.ad_headline = headline;
  return {
    canal: CANAL.META_ADS,
    via: VIA.ANUNCIO_WHATSAPP,
    clickIdType: clickId ? "ctwa_clid" : null,
    clickId,
    fbc: null,
    fbp: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    campaignId: null,
    adsetId: null,
    adId,
    campaignName: null,
    adsetName: null,
    adName: null,
    keyword: null,
    landingUrl: valorLimpo(ref.sourceUrl),
    referrer: null,
    clientUserAgent: null,
    occurredAt: null,
    extras,
  };
}
