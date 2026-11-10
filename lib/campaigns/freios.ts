/**
 * FREIOS da campanha: as razões para parar de mandar, num lugar só.
 *
 * Dois caminhos chegam aqui, e os dois terminam em `pausarCampanha`:
 *
 *   - o AVISO da Meta (webhook): modelo pausado ou com nota baixa, alerta ou violação da conta,
 *     número sinalizado. Para na hora, sem esperar o próximo minuto (`pausarCampanhasAtivas`).
 *   - o DESPACHANTE, antes de cada rodada (`freioAntesDaRodada`): confere o estado gravado —
 *     e mede o que só o despachante vê: cobrança recusada nas últimas mensagens e a taxa de
 *     pedidos para sair. É a rede de segurança do primeiro caminho (aviso perdido, assinatura
 *     do webhook faltando) e a única defesa contra o que a Meta não avisa.
 *
 * A pausa GUARDA O MOTIVO na campanha (`pausa_motivo` + `pausa_detalhe`) e abre um aviso crítico
 * na Central — o operador vê na própria campanha por que ela parou e o que fazer.
 *
 * Achados que motivaram (2026-11-09): Caruaru mandou 2.493 mensagens com a cobrança recusada;
 * Boa Viagem queimou 353 contatos com o modelo pausado pela Meta — a campanha seguia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { registrarAviso } from "@/lib/channels/aviso-de-canal";

import { TEXTO_DO_MOTIVO, type MotivoDePausa } from "./motivos-de-pausa";

/** "Business eligibility payment issue" — cartão ou moeda ausentes na conta do WhatsApp Business. */
export const CODIGO_META_COBRANCA = 131042;
/** Recusa NO ENVIO por modelo pausado (132015, nota baixa) ou desativado (132016). */
export const CODIGOS_DE_MODELO_BLOQUEADO = [132015, 132016] as const;

/** Cobrança: das últimas N enviadas, quantas recusadas bastam para pausar. */
export const AMOSTRA_DE_ENVIOS = 5;
export const RECUSAS_PARA_PAUSAR = 3;

/** Saídas: a taxa que pausa, e a base mínima antes de medir (1 saída em 20 não é sinal). */
export const LIMITE_DE_SAIDAS = 0.02;
export const BASE_MINIMA_DE_SAIDAS = 100;

export interface CampanhaParaFreio {
  id: string;
  organization_id: string;
  channel_session_id: string;
  name?: string | null;
  template_name?: string;
  template_language?: string;
  /** Desde a última retomada: os freios de taxa só olham o que saiu depois dela. */
  retomada_em?: string | null;
  /** O que o operador aceitou ao retomar (`MOTIVOS_DISPENSAVEIS`). */
  freios_dispensados?: string[] | null;
}

export interface Freio {
  motivo: MotivoDePausa;
  detalhe: string;
}

/** O estado do modelo e do número que o despachante já leu para mandar. */
export interface EstadoParaFreio {
  modelo: { status: string | null; quality_score: string | null } | null;
  qualidadeDoNumero: string | null;
}

function dispensado(campanha: CampanhaParaFreio, motivo: MotivoDePausa): boolean {
  return (campanha.freios_dispensados ?? []).includes(motivo);
}

/**
 * O que o estado gravado diz — sem consultar nada. Modelo antes de número: modelo pausado é
 * bloqueio certo; a nota é risco. Nota vermelha dispensada cobre a amarela (é melhor que ela).
 */
export function freioDoEstado(campanha: CampanhaParaFreio, estado: EstadoParaFreio): Freio | null {
  const nome = campanha.template_name ?? "o modelo";
  const status = estado.modelo?.status?.toUpperCase() ?? null;
  if (status === "PAUSED") {
    return { motivo: "modelo_pausado", detalhe: `A Meta pausou o modelo "${nome}" por baixa qualidade.` };
  }
  if (status && status !== "APPROVED") {
    return { motivo: "modelo_desativado", detalhe: `O modelo "${nome}" está ${status} na Meta.` };
  }

  const nota = estado.modelo?.quality_score?.toUpperCase() ?? null;
  if (nota === "RED" && !dispensado(campanha, "modelo_nota_vermelha")) {
    return { motivo: "modelo_nota_vermelha", detalhe: `A Meta deu nota vermelha ao modelo "${nome}".` };
  }
  if (
    nota === "YELLOW" &&
    !dispensado(campanha, "modelo_nota_amarela") &&
    !dispensado(campanha, "modelo_nota_vermelha")
  ) {
    return { motivo: "modelo_nota_amarela", detalhe: `A Meta deu nota amarela ao modelo "${nome}".` };
  }

  if (estado.qualidadeDoNumero?.toUpperCase() === "RED" && !dispensado(campanha, "numero_qualidade_baixa")) {
    return { motivo: "numero_qualidade_baixa", detalhe: "A Meta classificou a qualidade do número como baixa (vermelha)." };
  }
  return null;
}

/** A Meta recusou a cobrança da maioria das últimas mensagens (depois da retomada)? */
export async function cobrancaRecusada(admin: SupabaseClient, campanha: CampanhaParaFreio): Promise<boolean> {
  let consulta = admin
    .from("whatsapp_campaign_recipients")
    .select("external_id")
    .eq("campaign_id", campanha.id)
    .eq("status", "sent")
    .not("external_id", "is", null);
  if (campanha.retomada_em) consulta = consulta.gte("sent_at", campanha.retomada_em);
  const { data: ultimos } = await consulta.order("sent_at", { ascending: false }).limit(AMOSTRA_DE_ENVIOS);
  const ids = ((ultimos ?? []) as Array<{ external_id: string | null }>)
    .map((l) => l.external_id)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return false;

  const { data: falhas } = await admin
    .from("messages")
    .select("metadata")
    .eq("organization_id", campanha.organization_id)
    .eq("status", "failed")
    .in("external_id", ids);
  const recusadas = ((falhas ?? []) as Array<{ metadata: { failure_code?: unknown } | null }>).filter(
    (m) => Number(m.metadata?.failure_code) === CODIGO_META_COBRANCA,
  );
  return recusadas.length >= RECUSAS_PARA_PAUSAR;
}

/** O que `fn_resultado_da_campanha` devolve (migration 0218). */
export interface ResultadoDaCampanha {
  total: number;
  pendentes: number;
  aceitas: number;
  entregues: number;
  lidas: number;
  respostas: number;
  saidas: number;
  falhas: number;
  falhas_por_codigo: Record<string, number>;
}

export async function resultadoDaCampanha(
  admin: SupabaseClient,
  organizationId: string,
  campaignId: string,
  desde: string | null = null,
): Promise<ResultadoDaCampanha | null> {
  const { data, error } = await admin.rpc("fn_resultado_da_campanha", {
    p_org: organizationId,
    p_campaign: campaignId,
    p_desde: desde,
  });
  if (error || !data) return null;
  return data as ResultadoDaCampanha;
}

/**
 * A taxa de saída passou do limite? A base é quem RECEBEU: entregues quando a Meta já mandou
 * status de entrega, senão as aceitas (campanha anterior à leitura de entrega).
 */
export function freioDeSaidas(r: Pick<ResultadoDaCampanha, "aceitas" | "entregues" | "saidas">): Freio | null {
  const base = r.entregues > 0 ? r.entregues : r.aceitas;
  if (base < BASE_MINIMA_DE_SAIDAS) return null;
  const taxa = r.saidas / base;
  if (taxa < LIMITE_DE_SAIDAS) return null;
  const pct = (taxa * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return {
    motivo: "saidas_acima_do_limite",
    detalhe: `${r.saidas} de ${base} pessoas (${pct}%) pediram para sair depois de receber. O limite é 2%.`,
  };
}

/** Todas as razões para não mandar a próxima rodada, na ordem do mais barato ao mais caro. */
export async function freioAntesDaRodada(
  admin: SupabaseClient,
  campanha: CampanhaParaFreio,
  estado: EstadoParaFreio,
): Promise<Freio | null> {
  const doEstado = freioDoEstado(campanha, estado);
  if (doEstado) return doEstado;

  if (await cobrancaRecusada(admin, campanha)) {
    return {
      motivo: "cobranca_recusada",
      detalhe: `As últimas mensagens voltaram com o erro ${CODIGO_META_COBRANCA} (pagamento) e não chegaram aos clientes.`,
    };
  }

  const resultado = await resultadoDaCampanha(admin, campanha.organization_id, campanha.id, campanha.retomada_em ?? null);
  return resultado ? freioDeSaidas(resultado) : null;
}

/** O envio voltou recusado porque o MODELO está bloqueado? Então nada mais desta campanha sai. */
export function freioDoErroDeEnvio(mensagemDeErro: string, nomeDoModelo: string): Freio | null {
  const codigo = /^meta_(\d+)/.exec(mensagemDeErro)?.[1];
  if (codigo && (CODIGOS_DE_MODELO_BLOQUEADO as readonly number[]).includes(Number(codigo))) {
    return {
      motivo: Number(codigo) === 132015 ? "modelo_pausado" : "modelo_desativado",
      detalhe: `A Meta recusou o envio do modelo "${nomeDoModelo}" (erro ${codigo}).`,
    };
  }
  if (mensagemDeErro.startsWith("template_not_approved")) {
    return { motivo: "modelo_pausado", detalhe: `O modelo "${nomeDoModelo}" não está aprovado na Meta no momento.` };
  }
  return null;
}

/**
 * Pausa UMA campanha com o motivo e abre o aviso. Só pausa o que está andando — cancelar ou
 * concluir à mão não pode ser desfeito daqui. Devolve se pausou.
 */
export async function pausarCampanha(
  admin: SupabaseClient,
  campanha: Pick<CampanhaParaFreio, "id" | "organization_id" | "name">,
  freio: Freio,
): Promise<boolean> {
  const marca = {
    status: "paused",
    pausa_motivo: freio.motivo,
    pausa_detalhe: freio.detalhe.slice(0, 500),
    pausada_em: new Date().toISOString(),
  };
  let pausou = false;
  for (const andando of ["running", "queued"]) {
    const { data } = await admin
      .from("whatsapp_campaigns")
      .update(marca)
      .eq("id", campanha.id)
      .eq("organization_id", campanha.organization_id)
      .eq("status", andando)
      .select("id");
    if ((data ?? []).length > 0) pausou = true;
  }
  if (!pausou) return false;

  const texto = TEXTO_DO_MOTIVO[freio.motivo];
  await registrarAviso(admin, campanha.organization_id, {
    kind: "channel_number_alert",
    severity: "critical",
    title: `Campanha "${campanha.name ?? campanha.id}" pausada: ${texto.titulo.toLowerCase()}`,
    body: `${freio.detalhe} ${texto.acao}`,
  });
  return true;
}

/**
 * Pausa todas as campanhas andando dos canais (e, se dado, do modelo) — o caminho do aviso da
 * Meta. Campanha que já dispensou este motivo ao retomar segue. Devolve quantas pausou.
 */
export async function pausarCampanhasAtivas(
  admin: SupabaseClient,
  filtro: {
    organizationId: string;
    channelSessionIds: string[];
    templateName?: string;
    templateLanguage?: string;
  },
  freio: Freio,
): Promise<number> {
  if (filtro.channelSessionIds.length === 0) return 0;
  let consulta = admin
    .from("whatsapp_campaigns")
    .select("id, organization_id, name, freios_dispensados")
    .eq("organization_id", filtro.organizationId)
    .in("channel_session_id", filtro.channelSessionIds)
    .in("status", ["queued", "running"]);
  if (filtro.templateName) consulta = consulta.eq("template_name", filtro.templateName);
  if (filtro.templateLanguage) consulta = consulta.eq("template_language", filtro.templateLanguage);
  const { data } = await consulta;

  let pausadas = 0;
  for (const c of (data ?? []) as Array<CampanhaParaFreio>) {
    if (dispensado(c, freio.motivo)) continue;
    if (await pausarCampanha(admin, c, freio)) pausadas += 1;
  }
  return pausadas;
}
