/**
 * Da atribuição para as tags: de qual ORIGEM, CAMPANHA e ANÚNCIO o lead veio.
 *
 * PURO. Recebe o primeiro ponto de contato do lead (`lead_touchpoints`) e devolve
 * os `grupo:valor` que ele merece. Quem lê o banco e grava é `aplicar-tags.ts`.
 *
 * ─── Regras ─────────────────────────────────────────────────────────────────
 * • Origem é ADITIVA: anúncio do Instagram recebe `origem:meta-ads` E
 *   `origem:instagram`. Quem filtra "Meta Ads" quer todos os anúncios da Meta;
 *   quem filtra "Instagram" quer só os do Instagram.
 * • Instagram é detectado por sinal, nunca por palpite: `utm_source` instagram/ig, o
 *   link do anúncio (`www.instagram.com` — 526 dos 620 pontos de contato medidos em
 *   produção em 2026-10-28) ou o referenciador da visita.
 * • Campanha e anúncio só entram com NOME. Id numérico numa tag ("campanha:12038…")
 *   não diz nada a quem filtra; o nome chega depois (a Meta é consultada após o lead
 *   nascer) e a tag é acrescentada nessa hora.
 * • Canal `outro` (utm de origem que não é mídia paga) não vira tag: classificar
 *   "newsletter" como Origem encheria o filtro de ruído.
 */
import { CANAL, type PontoDeContato } from "./ponto-de-contato";
import { GRUPO, ORIGEM, limpaValor, montaTag, type GrupoChave } from "@/lib/tags/estruturadas";

export interface NomesDoAnuncio {
  campaignName?: string | null;
  adName?: string | null;
}

export interface TagDeOrigem {
  grupo: GrupoChave;
  valor: string;
}

type SinaisDoPonto = Pick<PontoDeContato, "canal" | "utmSource" | "landingUrl" | "referrer">;
export type PontoParaTags = SinaisDoPonto & Pick<PontoDeContato, "campaignName" | "adName">;

function hospedeDe(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function ehInstagram(host: string | null): boolean {
  return host === "instagram.com" || (host?.endsWith(".instagram.com") ?? false);
}

/** Valores de Origem do ponto, em ordem estável (mídia primeiro, depois a rede). */
export function origensDoPonto(p: SinaisDoPonto): string[] {
  switch (p.canal) {
    case CANAL.GOOGLE_ADS:
      return [ORIGEM.GOOGLE_ADS];
    case CANAL.TIKTOK_ADS:
      return [ORIGEM.TIKTOK_ADS];
    case CANAL.META_ADS: {
      const fonte = p.utmSource?.trim().toLowerCase();
      const instagram =
        fonte === "instagram" || fonte === "ig" || ehInstagram(hospedeDe(p.landingUrl)) || ehInstagram(hospedeDe(p.referrer));
      return instagram ? [ORIGEM.META_ADS, ORIGEM.INSTAGRAM] : [ORIGEM.META_ADS];
    }
    default:
      return [];
  }
}

export function tagsDeOrigem(p: PontoParaTags, nomes: NomesDoAnuncio = {}): TagDeOrigem[] {
  const origens = origensDoPonto(p);
  if (origens.length === 0) return [];

  const tags: TagDeOrigem[] = origens.map((valor) => ({ grupo: GRUPO.ORIGEM, valor }));
  const campanha = limpaValor(p.campaignName ?? nomes.campaignName);
  const anuncio = limpaValor(p.adName ?? nomes.adName);
  if (campanha) tags.push({ grupo: GRUPO.CAMPANHA, valor: campanha });
  if (anuncio) tags.push({ grupo: GRUPO.ANUNCIO, valor: anuncio });
  return tags;
}

/** `grupo:valor` prontos para gravar. */
export function textosDasTags(tags: readonly TagDeOrigem[]): string[] {
  return tags.map((t) => montaTag(t.grupo, t.valor)).filter((t): t is string => t !== null);
}
