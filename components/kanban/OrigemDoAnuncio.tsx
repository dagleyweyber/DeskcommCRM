"use client";

import { useAtribuicaoDoLead } from "@/hooks/leads/useAtribuicaoDoLead";
import { ROTULO_DO_CANAL, VIA } from "@/lib/atribuicao/ponto-de-contato";
import type { PontoDeContatoVisao } from "@/lib/atribuicao/visao";

/**
 * "De onde esse lead veio?" — campanha, conjunto e anúncio, dentro do dossiê.
 *
 * Pedido do dono da agência: para um lead de landing page ou de anúncio, saber de
 * qual campanha, conjunto e anúncio ele veio. O dado mora em `lead_touchpoints`
 * (migration 0202); este bloco é onde ele aparece para quem decide.
 *
 * Mostra o ÚLTIMO toque em destaque (o que trouxe a conversão) e, quando houve outro
 * antes, o PRIMEIRO numa linha discreta — "conheceu pelo Instagram, voltou pelo
 * Google" muda onde investir, e esconder um dos dois esconderia isso.
 *
 * Sem ponto de contato o bloco não aparece (mesma regra de `ConversaNoDossie`):
 * lead manual ou orgânico não tem origem de anúncio, e um "sem origem" cinza não
 * diria nada a quem já sabe que o lead foi criado à mão.
 */
const ROTULO_DA_VIA: Record<string, string> = {
  [VIA.ANUNCIO_WHATSAPP]: "anúncio para WhatsApp",
  [VIA.LANDING_PAGE]: "landing page",
  [VIA.HISTORICO]: "registro anterior",
};

function rotuloDoCanal(canal: string, utmSource: string | null): string {
  if (canal === "outro" && utmSource) return utmSource;
  return ROTULO_DO_CANAL[canal] ?? canal;
}

function nomeOuId(nome: string | null, id: string | null): string | null {
  if (nome && id) return `${nome} · ${id}`;
  return nome ?? id;
}

function paginaCurta(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div className="flex gap-2 text-xs">
      <dt className="w-24 shrink-0 text-text-muted">{rotulo}</dt>
      <dd className="min-w-0 break-words text-text">{valor}</dd>
    </div>
  );
}

function Detalhes({ p }: { p: PontoDeContatoVisao }) {
  const google = p.canal === "google_ads";
  return (
    <dl className="mt-1.5 space-y-1">
      <Linha rotulo="Campanha" valor={nomeOuId(p.campaign_name, p.campaign_id)} />
      <Linha rotulo={google ? "Grupo" : "Conjunto"} valor={nomeOuId(p.adset_name, p.adset_id)} />
      <Linha rotulo="Anúncio" valor={nomeOuId(p.ad_name, p.ad_id)} />
      <Linha rotulo="Título" valor={p.ad_headline} />
      <Linha rotulo="Palavra-chave" valor={p.keyword} />
      <Linha rotulo="Página" valor={p.via === VIA.LANDING_PAGE ? paginaCurta(p.landing_url) : null} />
    </dl>
  );
}

export function OrigemDoAnuncio({ leadId }: { leadId: string }) {
  const { data } = useAtribuicaoDoLead(leadId);
  const pontos = data?.pontos ?? [];
  if (pontos.length === 0) return null;

  const ultimo = pontos[pontos.length - 1]!;
  const primeiro = pontos.length > 1 ? pontos[0]! : null;

  return (
    <section className="mt-3 rounded-md border border-border px-3 py-2" data-testid="origem-do-anuncio">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Origem do anúncio</h3>
      <p className="mt-1 text-xs text-text">
        <span className="font-medium">{rotuloDoCanal(ultimo.canal, ultimo.utm_source)}</span>
        <span className="text-text-muted">
          {" "}
          · {ROTULO_DA_VIA[ultimo.via] ?? ultimo.via} · {new Date(ultimo.occurred_at).toLocaleDateString("pt-BR")}
          {ultimo.tem_clique ? " · clique rastreado" : ""}
        </span>
      </p>
      <Detalhes p={ultimo} />
      {primeiro && (
        <p className="mt-2 border-t border-border pt-1.5 text-[11px] text-text-muted">
          Primeiro contato: {rotuloDoCanal(primeiro.canal, primeiro.utm_source)}
          {primeiro.campaign_name || primeiro.campaign_id
            ? ` · ${nomeOuId(primeiro.campaign_name, primeiro.campaign_id)}`
            : ""}{" "}
          · {new Date(primeiro.occurred_at).toLocaleDateString("pt-BR")}
        </p>
      )}
    </section>
  );
}
