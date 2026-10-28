/**
 * Clique no botão do WhatsApp de uma landing page — o código que liga o clique à conversa.
 *
 * ─── O problema ─────────────────────────────────────────────────────────────
 * Anúncio da Meta para WhatsApp entrega `ctwa_clid` junto com a primeira mensagem. O
 * Google não entrega NADA: o anúncio leva a uma landing page, a pessoa clica no botão do
 * WhatsApp e a conversa nasce sem origem — o `gclid` ficou na página. Sem origem, a
 * conversão offline nunca volta ao Google Ads.
 *
 * ─── A ponte ────────────────────────────────────────────────────────────────
 * O script da página (`public/rastreio.js`) acrescenta ao texto do link do WhatsApp um
 * código curto — `ref:K7M2QX` — e registra o clique (`rastreio_cliques`, migration 0203)
 * com os parâmetros do anúncio. Quando a mensagem chega ao CRM com o código, a conversa é
 * ligada ao clique (`ligar-clique.ts`).
 *
 * É melhor-esforço e a tela diz isso: a pessoa pode apagar o código antes de enviar. O
 * que se mede é a taxa de ligação, não se promete 100%.
 *
 * PURO. O alfabeto e o formato têm de ser os MESMOS de `public/rastreio.js` (o teste do
 * script confere) e do CHECK da tabela (`^[A-HJ-NP-Z2-9]{6}$`).
 */
import { CHAVES_DE_ATRIBUICAO, CAMPO_PRIMEIRO_CONTATO, valorLimpo } from "./ponto-de-contato";

/** 32 símbolos, sem 0/O/1/I (confundem na leitura e na digitação). 32^6 ≈ 1 bilhão. */
export const ALFABETO_DO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TAMANHO_DO_CODIGO = 6;
const CODIGO_EXATO = /^[A-HJ-NP-Z2-9]{6}$/;
/** `ref:K7M2QX`, `ref K7M2QX`, `(ref-k7m2qx)` — o cliente pode ter mexido na pontuação. */
const CODIGO_NA_MENSAGEM = /\bref[:\s-]+([A-HJ-NP-Z2-9]{6})\b/i;

/** Quanto tempo depois do clique a mensagem ainda é ligada a ele. */
export const VALIDADE_DO_CLIQUE_DIAS = 14;

export function normalizaCodigo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const c = bruto.trim().toUpperCase();
  return CODIGO_EXATO.test(c) ? c : null;
}

/** O código dentro do texto que a pessoa mandou, ou null. */
export function extraiCodigoDaMensagem(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = CODIGO_NA_MENSAGEM.exec(texto);
  return m ? normalizaCodigo(m[1]) : null;
}

/**
 * Parâmetros que a rota pública aceita guardar. ALLOWLIST: a rota é aberta (o script roda
 * em página de terceiros) e não pode virar depósito de JSON arbitrário.
 */
export const PARAMETROS_DO_CLIQUE: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  ...CHAVES_DE_ATRIBUICAO,
  CAMPO_PRIMEIRO_CONTATO,
];

/** O primeiro toque vem como JSON em texto: limite próprio, maior que o de um parâmetro. */
const LIMITE_DO_PRIMEIRO_CONTATO = 3000;

export function parametrosDoClique(corpo: Record<string, unknown>): Record<string, string> {
  const achados: Record<string, string> = {};
  for (const [k, v] of Object.entries(corpo)) {
    const chave = k.toLowerCase();
    if (!PARAMETROS_DO_CLIQUE.includes(chave)) continue;
    if (chave === CAMPO_PRIMEIRO_CONTATO) {
      if (typeof v === "string" && v.length > 0 && v.length <= LIMITE_DO_PRIMEIRO_CONTATO) achados[chave] = v;
      continue;
    }
    const limpo = valorLimpo(v);
    if (limpo) achados[chave] = limpo;
  }
  return achados;
}

/** Tem algum sinal de anúncio? Clique sem origem não vale uma linha. */
export function temSinalDeAnuncio(parametros: Record<string, string>): boolean {
  return Object.keys(parametros).some((k) => k !== CAMPO_PRIMEIRO_CONTATO && !["landing_url", "page_url", "referrer", "client_user_agent"].includes(k));
}
