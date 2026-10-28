/**
 * O que o painel de envios mostra: por evento, quantos leads a Meta aceitou e quantos
 * nunca foram aceitos — e POR QUÊ, com o que fazer.
 *
 * Conta LEAD, não tentativa: o log tem uma linha por tentativa (reenvio incluído), e
 * contar linhas fazia "25 vendas recusadas" aparecer como "140 falhas" — número que
 * assusta sem dizer quantas vendas estão de fato fora da otimização.
 *
 * Puro: a rota lê `meta_capi_send_log` e entrega as linhas aqui.
 */
import { interpretaErroDaMeta } from "./erro-da-meta";

export interface LinhaDeEnvio {
  lead_id: string;
  event_name: string;
  status: string;
  meta_error: string | null;
  created_at: string;
}

export interface MotivoDeRecusa {
  motivo: string;
  oQueFazer: string | null;
  leads: number;
}

export interface ResumoDoEvento {
  evento: string;
  aceitos: number;
  recusados: number;
  motivos: MotivoDeRecusa[];
}

export function resumeEnvios(linhas: readonly LinhaDeEnvio[]): ResumoDoEvento[] {
  // (evento, lead) → foi aceito alguma vez? + o erro mais recente
  const porLead = new Map<string, { evento: string; aceito: boolean; ultimoErro: string | null; quando: string }>();
  for (const l of linhas) {
    const chave = `${l.event_name}\u0000${l.lead_id}`;
    const atual = porLead.get(chave);
    const aceito = l.status === "sent";
    if (!atual) {
      porLead.set(chave, { evento: l.event_name, aceito, ultimoErro: aceito ? null : l.meta_error, quando: l.created_at });
      continue;
    }
    if (aceito) atual.aceito = true;
    if (!aceito && l.created_at >= atual.quando) {
      atual.ultimoErro = l.meta_error;
      atual.quando = l.created_at;
    }
  }

  const porEvento = new Map<string, ResumoDoEvento & { _motivos: Map<string, MotivoDeRecusa> }>();
  for (const { evento, aceito, ultimoErro } of porLead.values()) {
    let r = porEvento.get(evento);
    if (!r) {
      r = { evento, aceitos: 0, recusados: 0, motivos: [], _motivos: new Map() };
      porEvento.set(evento, r);
    }
    if (aceito) {
      r.aceitos += 1;
      continue;
    }
    r.recusados += 1;
    const e = interpretaErroDaMeta(ultimoErro);
    const m = r._motivos.get(e.motivo) ?? { motivo: e.motivo, oQueFazer: e.oQueFazer, leads: 0 };
    m.leads += 1;
    r._motivos.set(e.motivo, m);
  }

  return [...porEvento.values()]
    .map(({ _motivos, ...r }) => ({ ...r, motivos: [..._motivos.values()].sort((a, b) => b.leads - a.leads) }))
    .sort((a, b) => b.aceitos + b.recusados - (a.aceitos + a.recusados));
}
