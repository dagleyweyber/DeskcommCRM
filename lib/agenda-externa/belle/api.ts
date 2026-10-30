/**
 * Cliente HTTP da API de Integração Externa do Belle Software.
 *
 * Documentação: https://app.bellesoftware.com.br/api.php (Postman). Tudo aqui é
 * LEITURA — a Fase 1 da integração não escreve nada no Belle.
 *
 * Fatos medidos com um token real (B'Laser Parnamirim, 2026-10-29), não lidos da
 * documentação:
 *   - o token enxerga UMA unidade (`/estabelecimento` devolve uma linha);
 *   - não há limite de dias por consulta, mas 60 dias do relatório levaram 60 s —
 *     por isso a sincronização pede fatias curtas;
 *   - a lista de agendamentos traz o celular e NÃO traz a duração; o relatório de
 *     atendimentos traz a duração (`minutosAgendamento`) e NÃO traz o celular. A
 *     sincronização junta os dois pelo código do agendamento.
 *
 * Limite do Belle: 40 requisições por minuto por token. Uma rodada usa poucas.
 */
import { z } from "zod";

const BASE = "https://app.bellesoftware.com.br/api/release/controller/IntegracaoExterna/v1.0";

/** Token recusado pelo Belle — a conexão vira `invalid` e a tela pede um novo. */
export class TokenBelleInvalido extends Error {
  constructor() {
    super("O Belle recusou o token de integração.");
  }
}

/** Qualquer outra falha (rede, 5xx, resposta fora do formato). */
export class FalhaNoBelle extends Error {}

const texto = z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? "" : String(v).trim()));

export const estabelecimentoSchema = z.object({
  codigo: texto,
  nomeFantasia: texto,
  telefone: texto,
});
export type EstabelecimentoBelle = z.infer<typeof estabelecimentoSchema>;

/** Serviço do catálogo: `tipo` vem como "4359 - Depilação" (código - nome). */
export const servicoDoCatalogoSchema = z.object({
  codServico: texto,
  nome: texto,
  tipo: texto,
});
export type ServicoDoCatalogo = z.infer<typeof servicoDoCatalogoSchema>;

export const agendamentoDaListaSchema = z.object({
  codConsulta: texto,
  dtAgenda: texto,
  hrConsulta: texto,
  status: texto,
  tipo: texto,
  observacao: texto,
  cliente: z.object({ cod: texto, nome: texto, celular: texto }).partial().nullish(),
  sala: z.object({ cod: texto, nome: texto }).partial().nullish(),
  servicos: z.array(z.object({ cod: texto, nome: texto }).partial()).nullish(),
});
export type AgendamentoDaLista = z.infer<typeof agendamentoDaListaSchema>;

export const linhaDoRelatorioSchema = z.object({
  idAgendamento: texto,
  dataAgendamento: texto,
  horarioAgendamento: texto,
  minutosAgendamento: z.union([z.number(), z.string()]).nullish().transform((v) => (v == null || v === "" ? null : Number(v))),
  codigoCliente: texto,
  nomeCliente: texto,
  salaAgendamento: texto,
  codigoServico: texto,
  nomeServico: texto,
  tipoAgendamento: texto,
  statusAgendamento: texto,
});
export type LinhaDoRelatorio = z.infer<typeof linhaDoRelatorioSchema>;

export interface ClienteBelleOpcoes {
  token: string;
  /** Injetável nos testes. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** "2026-10-29" → "29/10/2026" (formato que a API espera). */
export function dataParaBelle(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export function criarClienteBelle({ token, fetchImpl = fetch, timeoutMs = 50_000 }: ClienteBelleOpcoes) {
  async function get<T>(caminho: string, schema: z.ZodType<T, unknown>): Promise<T[]> {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}/${caminho}`, {
        headers: { Authorization: token, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      throw new FalhaNoBelle(`Sem resposta do Belle (${err instanceof Error ? err.name : "erro"}).`);
    }
    if (res.status === 401 || res.status === 403) throw new TokenBelleInvalido();
    if (!res.ok) throw new FalhaNoBelle(`O Belle respondeu ${res.status}.`);
    let corpo: unknown;
    try {
      corpo = await res.json();
    } catch {
      throw new FalhaNoBelle("O Belle respondeu em formato inesperado.");
    }
    // Sem resultado o Belle às vezes devolve objeto em vez de lista vazia.
    if (!Array.isArray(corpo)) {
      const erro = (corpo as { error?: unknown } | null)?.error;
      if (typeof erro === "string" && /token|autoriz|authori/i.test(erro)) throw new TokenBelleInvalido();
      return [];
    }
    const saida: T[] = [];
    for (const item of corpo) {
      const r = schema.safeParse(item);
      if (r.success) saida.push(r.data);
    }
    return saida;
  }

  return {
    estabelecimentos: () => get("estabelecimento", estabelecimentoSchema),
    /** Catálogo de serviços — é dele que sai o TIPO de cada serviço (~330 na B'Laser, 1 chamada). */
    servicos: () => get("servico/listar", servicoDoCatalogoSchema),
    /** Agendamentos em aberto (Marcado, Confirmado, Em Andamento…), com celular. */
    agendamentosEmAberto: (codEstab: string, de: string, ate: string) =>
      get(
        `agendamentos?codEstab=${encodeURIComponent(codEstab)}&dtInicio=${dataParaBelle(de)}&dtFim=${dataParaBelle(ate)}`,
        agendamentoDaListaSchema,
      ),
    /** Agendamentos atendidos, com celular. */
    agendamentosFinalizados: (codEstab: string, de: string, ate: string) =>
      get(
        `agendamentos/finalizados?codEstab=${encodeURIComponent(codEstab)}&dtInicio=${dataParaBelle(de)}&dtFim=${dataParaBelle(ate)}`,
        agendamentoDaListaSchema,
      ),
    /** Todos os agendamentos do período, de qualquer status, com a duração. */
    relatorioDeAtendimentos: (codEstab: string, de: string, ate: string) =>
      get(
        `relatorios/relatorio_atendimentos?codEstab=${encodeURIComponent(codEstab)}&dtInicio=${dataParaBelle(de)}&dtFim=${dataParaBelle(ate)}`,
        linhaDoRelatorioSchema,
      ),
  };
}

export type ClienteBelle = ReturnType<typeof criarClienteBelle>;
