/**
 * O que a Meta quis dizer quando recusou um evento do Conversions API — em português,
 * com o que fazer.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 * Produção, 30 dias (2026-10-28): B'laser Caruaru com 25 vendas NUNCA aceitas e 4
 * aceitas; RevitaFio Mossoró com 17 "Lead" recusados. Enquanto isso a conexão aparecia
 * "Conectado" na tela, e o CRM reenviava cada recusa 5 vezes (140 tentativas em 7 dias
 * só na Caruaru) mesmo com a Meta dizendo `is_transient: false` — reenviar não muda
 * nada quando o problema é configuração. O que chegava ao operador era um aviso crítico
 * POR LEAD com o JSON cru da Meta: nenhum dizia o que fazer.
 *
 * Esta função é pura: lê o corpo do erro que `send.ts` grava (`http_<status>: <json>`)
 * e devolve o motivo, se vale reenviar, e — para os casos conhecidos — a instrução.
 */

export interface ErroDaMeta {
  /** `error_subcode` da Meta, quando veio. */
  subcode: string | null;
  /**
   * Vale tentar de novo? `false` só quando a Meta disse explicitamente
   * `is_transient: false` — erro de rede, 5xx ou corpo ilegível continuam sendo
   * reenviados (não dá para saber que não adianta).
   */
  transitorio: boolean;
  /** Erro de CONFIGURAÇÃO (conta, conjunto de dados, token) — afeta todo envio da organização. */
  deConfiguracao: boolean;
  /** Frase curta em português. */
  motivo: string;
  /** O que a pessoa faz para resolver, quando sabemos. */
  oQueFazer: string | null;
}

interface CorpoDeErro {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    error_user_title?: string;
    error_user_msg?: string;
  };
}

function lerCorpo(bruto: string): CorpoDeErro | null {
  const i = bruto.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(bruto.slice(i)) as CorpoDeErro;
  } catch {
    return lerCorpoCortado(bruto.slice(i));
  }
}

/**
 * Corpo que não é JSON válido — o log guardou só o começo da resposta (o corte era
 * menor em versões antigas). Os campos que decidem o tratamento vêm no início do
 * objeto, então ainda dá para lê-los; sem isso o painel mostrava o JSON cru.
 */
function lerCorpoCortado(trecho: string): CorpoDeErro | null {
  const numero = (campo: string): number | undefined => {
    const m = new RegExp(`"${campo}"\\s*:\\s*(\\d+)`).exec(trecho);
    return m ? Number(m[1]) : undefined;
  };
  const code = numero("code");
  const error_subcode = numero("error_subcode");
  if (code === undefined && error_subcode === undefined) return null;
  const transiente = /"is_transient"\s*:\s*(true|false)/.exec(trecho);
  return {
    error: {
      code,
      error_subcode,
      is_transient: transiente ? transiente[1] === "true" : undefined,
    },
  };
}

const CONHECIDOS: Record<string, { motivo: string; oQueFazer: string; deConfiguracao: boolean }> = {
  "2804131": {
    motivo: "O conjunto de dados do Meta Ads não está associado à Página do Facebook dos anúncios de WhatsApp.",
    oQueFazer:
      "No Gerenciador de Negócios da Meta, associe este conjunto de dados à Página do Facebook que roda os anúncios de WhatsApp. Os envios seguintes passam a ser aceitos.",
    deConfiguracao: true,
  },
  "2804116": {
    motivo: "Faltou identificar a Página ou a conta do WhatsApp Business do anúncio.",
    oQueFazer:
      "Conecte a \"Leitura de campanha e anúncio\" nesta tela — é por ela que o CRM descobre a Página de cada anúncio.",
    deConfiguracao: true,
  },
  "2804066": {
    motivo: "A Meta não aceita este nome de evento para conversas de WhatsApp.",
    // "Lead" era o caso medido, e o CRM já o envia como "LeadSubmitted" desde 2026-10-28
    // (capi.ts → nomeDoEventoPara). Recusa nova com este código é de outro evento.
    oQueFazer:
      "Para \"Lead\", o CRM já corrige sozinho: os envios novos vão como \"LeadSubmitted\", que a Meta aceita. Se a recusa for de outro evento, escolha outro evento para essa etapa do funil (em Funis → etapas).",
    deConfiguracao: true,
  },
  "2804010": {
    motivo: "Venda enviada sem valor ou sem moeda.",
    oQueFazer: "Preencha o valor do negócio ao marcar como ganho.",
    deConfiguracao: false,
  },
};

export function interpretaErroDaMeta(bruto: string | null | undefined): ErroDaMeta {
  const texto = (bruto ?? "").trim();
  const corpo = lerCorpo(texto);
  const e = corpo?.error;
  const subcode = e?.error_subcode != null ? String(e.error_subcode) : null;

  // Token expirado/revogado (code 190) — tudo para de funcionar até reconectar.
  if (e?.code === 190) {
    return {
      subcode,
      transitorio: false,
      deConfiguracao: true,
      motivo: "O token de acesso do Meta Ads expirou ou foi revogado.",
      oQueFazer: "Desconecte e conecte o Meta Ads de novo, com um token novo.",
    };
  }

  const conhecido = subcode ? CONHECIDOS[subcode] : undefined;
  const transitorio = e?.is_transient === false ? false : true;

  if (conhecido) {
    return { subcode, transitorio, ...conhecido };
  }

  const motivo =
    e?.error_user_title?.trim() ||
    e?.error_user_msg?.trim() ||
    e?.message?.trim() ||
    (texto ? texto.slice(0, 200) : "Erro desconhecido da Meta.");
  return { subcode, transitorio, deConfiguracao: false, motivo, oQueFazer: null };
}
