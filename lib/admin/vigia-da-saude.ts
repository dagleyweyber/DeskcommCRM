/**
 * Vigia da saúde das clínicas — o painel deixa de depender de alguém abrir.
 *
 * `/admin/saude` (migration 0186) mostra quem está quebrado, mas só para quem
 * abre a tela. Com 50 clínicas, "lembrar de olhar" não é mecanismo: o jeito
 * real de descobrir problema continuaria sendo a clínica ligando. Este vigia
 * roda sozinho, usa a MESMA função e a MESMA régua do painel, e materializa o
 * que achou em `incidents` — que já tem tela (`/admin/incidents`) e nunca teve
 * produtor automático nenhum.
 *
 * ## Só CRÍTICO vira incidente
 *
 * `atencao` fica no painel e não gera alerta. Alerta que dispara com o que é
 * tolerável ensina a ignorar alerta — e aí ele falha no dia em que importa. A
 * medida disso existe e é observável: a Central de uma das clínicas já tem 800
 * avisos abertos, ou seja, ninguém lê mais nenhum.
 *
 * ## Fecha sozinho
 *
 * Incidente que não se resolve sozinho vira entulho — a mesma doença dos 800
 * avisos. Quando o sinal volta ao normal, o incidente é resolvido com nota
 * automática. O que fica aberto é o que ainda está quebrado AGORA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  classificaClinica,
  type SaudeDaClinica,
  type SinaisDaClinica,
} from "@/lib/admin/saude-das-clinicas";
import { logger } from "@/lib/logger";

/** Um tipo de incidente por SINAL: o admin lê o que quebrou sem abrir nada. */
export const TIPOS_DE_INCIDENTE = {
  canal: "clinica.canal_fora_do_ar",
  ia: "clinica.ia_sem_credencial",
  fila: "clinica.fila_parada",
  mensagens: "clinica.mensagens_falhando",
} as const;

export type TipoDeIncidente = (typeof TIPOS_DE_INCIDENTE)[keyof typeof TIPOS_DE_INCIDENTE];

/** Os tipos que ESTE vigia governa — nunca mexe em incidente de outra origem. */
export const TIPOS_GOVERNADOS: readonly string[] = Object.values(TIPOS_DE_INCIDENTE);

export interface IncidenteAberto {
  id: string;
  organization_id: string | null;
  type: string;
}

export interface NovoIncidente {
  organization_id: string;
  type: TipoDeIncidente;
  severity: "critical";
  payload: Record<string, unknown>;
}

export interface Decisao {
  abrir: NovoIncidente[];
  /** ids de incidentes a resolver — o sinal voltou ao normal. */
  resolver: string[];
}

export interface ResultadoDaVigia extends Decisao {
  clinicas_verificadas: number;
}

/**
 * O QUE abrir e o QUE fechar, dado o retrato de agora e o que já está aberto.
 *
 * Pura de propósito: é aqui que mora a regra de dedup (não reabrir o que já
 * está aberto) e a de recuperação (fechar o que voltou), e as duas precisam de
 * teste sem banco.
 */
export function decideIncidentes(
  clinicas: readonly SaudeDaClinica[],
  abertos: readonly IncidenteAberto[],
): Decisao {
  const chave = (org: string, tipo: string) => `${org}::${tipo}`;

  const jaAberto = new Map<string, string>();
  for (const inc of abertos) {
    if (inc.organization_id === null) continue;
    if (!TIPOS_GOVERNADOS.includes(inc.type)) continue;
    jaAberto.set(chave(inc.organization_id, inc.type), inc.id);
  }

  const abrir: NovoIncidente[] = [];
  const aindaCritico = new Set<string>();

  for (const c of clinicas) {
    // Conta suspensa não gera alerta: canal parado ali é o esperado.
    if (c.geral === "suspenso") continue;

    const sinais: Array<[TipoDeIncidente, { saude: string; detalhe: string }]> = [
      [TIPOS_DE_INCIDENTE.canal, c.canal],
      [TIPOS_DE_INCIDENTE.ia, c.ia],
      [TIPOS_DE_INCIDENTE.fila, c.fila],
      [TIPOS_DE_INCIDENTE.mensagens, c.mensagens],
    ];

    for (const [tipo, sinal] of sinais) {
      if (sinal.saude !== "critico") continue;
      const k = chave(c.organization_id, tipo);
      aindaCritico.add(k);
      if (jaAberto.has(k)) continue; // dedup: já tem incidente aberto
      abrir.push({
        organization_id: c.organization_id,
        type: tipo,
        severity: "critical",
        payload: { clinica: c.display_name, slug: c.slug, detalhe: sinal.detalhe },
      });
    }
  }

  // Fecha o que voltou ao normal. Clínica que sumiu do retrato (foi apagada,
  // anonimizada) também resolve: manter aberto um incidente de organização que
  // já não existe é entulho que ninguém consegue sequer investigar.
  const resolver: string[] = [];
  for (const [k, id] of jaAberto) {
    if (!aindaCritico.has(k)) resolver.push(id);
  }

  return { abrir, resolver };
}

/** Um ciclo do vigia: lê o retrato, compara com o que está aberto, concilia. */
export async function vigiaSaudeDasClinicas(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDaVigia> {
  const vazio: ResultadoDaVigia = { clinicas_verificadas: 0, abrir: [], resolver: [] };

  const { data: linhas, error: erroRpc } = await admin.rpc("fn_saude_das_clinicas" as never);
  if (erroRpc) {
    logger.error("[vigia-da-saude] fn_saude_das_clinicas falhou", { error: erroRpc.message });
    return vazio;
  }

  const clinicas = ((linhas ?? []) as unknown as SinaisDaClinica[]).map((l) =>
    classificaClinica(l, agora),
  );

  const { data: abertosRaw, error: erroAbertos } = await admin
    .from("incidents")
    .select("id, organization_id, type")
    .in("type", TIPOS_GOVERNADOS)
    .in("status", ["open", "acknowledged"]);
  if (erroAbertos) {
    logger.error("[vigia-da-saude] leitura de incidentes abertos falhou", {
      error: erroAbertos.message,
    });
    return vazio;
  }

  const decisao = decideIncidentes(clinicas, (abertosRaw ?? []) as IncidenteAberto[]);

  if (decisao.abrir.length > 0) {
    const { error } = await admin.from("incidents").insert(decisao.abrir);
    if (error) {
      logger.error("[vigia-da-saude] abertura de incidentes falhou", { error: error.message });
    } else {
      // Clínica quebrada é acontecimento, não rotina: sai no log mesmo quando
      // ninguém está olhando a tela.
      for (const inc of decisao.abrir) {
        logger.warn("[vigia-da-saude] clínica em estado crítico", {
          organization_id: inc.organization_id,
          tipo: inc.type,
          detalhe: inc.payload.detalhe,
        });
      }
    }
  }

  if (decisao.resolver.length > 0) {
    const { error } = await admin
      .from("incidents")
      .update({
        status: "resolved",
        resolved_at: agora.toISOString(),
        resolution_note: "Resolvido automaticamente: o sinal voltou ao normal.",
        updated_at: agora.toISOString(),
      })
      .in("id", decisao.resolver);
    if (error) {
      logger.error("[vigia-da-saude] resolução automática falhou", { error: error.message });
    }
  }

  return { clinicas_verificadas: clinicas.length, ...decisao };
}
