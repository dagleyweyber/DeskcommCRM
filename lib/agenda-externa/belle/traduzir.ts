/**
 * Tradução Belle → Agenda do CRM. Funções puras: nenhuma chamada de rede ou banco.
 *
 * As duas fontes do Belle se completam (ver api.ts): o relatório de atendimentos
 * traz TODOS os agendamentos do período, com a duração; as listas trazem o celular
 * e os serviços. A junção é pelo código do agendamento.
 */
import { instanteDoMomentoLocal } from "@/lib/agenda/fuso";
import type { StatusDoCompromisso } from "@/lib/agenda/tipos";

import type { AgendamentoDaLista, LinhaDoRelatorio, ServicoDoCatalogo } from "./api";

/** Tipo de serviço do Belle, como a tela de ligação mostra. */
export interface TipoDeServico {
  /** Estável: "tipo:4359" (tipo do catálogo) ou "agendamento:avaliacao" (sem serviço). */
  chave: string;
  rotulo: string;
}

/** "4359 - Depilação" → { chave: "tipo:4359", rotulo: "Depilação" }. */
export function tipoDoCatalogo(tipo: string): TipoDeServico | null {
  const m = /^\s*(\d+)\s*-\s*(.+?)\s*$/.exec(tipo);
  if (m) return { chave: `tipo:${m[1]}`, rotulo: m[2]! };
  const t = tipo.trim();
  return t ? { chave: `tipo:${chaveDoNome(t)}`, rotulo: t } : null;
}

/** Código do serviço (sem os espaços que o Belle às vezes põe) → tipo dele. */
export function catalogoPorCodigo(servicos: ServicoDoCatalogo[]): Map<string, TipoDeServico> {
  const mapa = new Map<string, TipoDeServico>();
  for (const s of servicos) {
    const tipo = tipoDoCatalogo(s.tipo);
    if (s.codServico.trim() && tipo) mapa.set(s.codServico.trim(), tipo);
  }
  return mapa;
}

/**
 * O tipo de UM agendamento: o do primeiro serviço que o catálogo conhece (a
 * paciente recebe UMA mensagem, mesmo com depilação + estética no mesmo horário).
 * Sem serviço — a avaliação, por exemplo — vale o tipo do agendamento.
 */
export function tipoDoAgendamento(
  codigosDosServicos: string[],
  tipoDoAgendamentoBelle: string,
  catalogo: Map<string, TipoDeServico>,
): TipoDeServico | null {
  for (const cod of codigosDosServicos) {
    const tipo = catalogo.get(cod.trim());
    if (tipo) return tipo;
  }
  const t = tipoDoAgendamentoBelle.trim();
  return t ? { chave: `agendamento:${chaveDoNome(t)}`, rotulo: t } : null;
}

/** Duração quando o Belle não informa (não aconteceu nas medições, mas não há garantia). */
export const DURACAO_PADRAO_MIN = 30;

/**
 * Status do Belle → status da Agenda. O texto original fica em `external_status`.
 * "Antecipado" e "Aguardando" são etapas do dia antes do atendimento: ainda
 * "Agendado". "Em Andamento" já está na clínica: conta como confirmado.
 */
const STATUS: Record<string, StatusDoCompromisso> = {
  marcado: "pending",
  aguardando: "pending",
  antecipado: "pending",
  confirmado: "confirmed",
  "em andamento": "confirmed",
  atendido: "completed",
  falhou: "no_show",
  desmarcado: "cancelled",
  cancelado: "cancelled",
};

export function statusDoBelle(statusBelle: string): StatusDoCompromisso {
  return STATUS[statusBelle.trim().toLowerCase()] ?? "pending";
}

/** DDD de um telefone como o Belle o escreve: "(84)3333-4444" → "84". */
export function dddDoTelefone(telefone: string | null | undefined): string | null {
  const m = /\((\d{2})\)/.exec(telefone ?? "");
  if (m) return m[1]!;
  const digitos = (telefone ?? "").replace(/\D/g, "");
  return digitos.length === 10 || digitos.length === 11 ? digitos.slice(0, 2) : null;
}

/**
 * Celular do Belle → E.164 brasileiro. O cadastro do Belle mistura formatos:
 * "(81)98756-1002", "8198756-1002" e até "987561002" sem DDD — este último usa o
 * DDD da unidade. Devolve null quando não dá para ter certeza do número.
 */
export function telefoneDoBelle(celular: string | null | undefined, dddPadrao: string | null): string | null {
  const digitos = (celular ?? "").replace(/\D/g, "");
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")) return `+${digitos}`;
  if (digitos.length === 10 || digitos.length === 11) return `+55${digitos}`;
  if ((digitos.length === 8 || digitos.length === 9) && dddPadrao && /^\d{2}$/.test(dddPadrao)) {
    return `+55${dddPadrao}${digitos}`;
  }
  return null;
}

/**
 * As grafias do mesmo celular no CRM: o WhatsApp entrega muitos números do
 * Nordeste SEM o nono dígito (+55 81 8765-1002), e o Belle guarda COM ele.
 * Casar só pela grafia exata duplicaria a paciente que já conversa pelo WhatsApp.
 */
export function variantesDoTelefone(e164: string): string[] {
  const d = e164.replace(/\D/g, "");
  if (!d.startsWith("55")) return [e164];
  const ddd = d.slice(2, 4);
  const local = d.slice(4);
  if (local.length === 9 && local.startsWith("9")) return [`+${d}`, `+55${ddd}${local.slice(1)}`];
  if (local.length === 8 && /^[6-9]/.test(local)) return [`+${d}`, `+55${ddd}9${local}`];
  return [`+${d}`];
}

/** "29/10/2026" → "2026-10-29". */
export function dataDoBelle(dt: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dt.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export interface AgendamentoImportado {
  externalId: string;
  startsAt: string;
  endsAt: string;
  status: StatusDoCompromisso;
  statusExterno: string;
  salaCodigo: string | null;
  salaNome: string;
  titulo: string;
  notas: string | null;
  cliente: { codigo: string; nome: string; celular: string };
  /** Tipo de serviço (ligado a um serviço da Agenda na tela do Belle). */
  tipo: TipoDeServico | null;
}

function tituloDe(lista: AgendamentoDaLista | undefined, linha: LinhaDoRelatorio | undefined): string {
  const servicos = (lista?.servicos ?? []).map((s) => (s.nome ?? "").trim()).filter(Boolean);
  if (servicos.length) return servicos.join(", ").slice(0, 300);
  const doRelatorio = linha?.nomeServico?.trim();
  if (doRelatorio) return doRelatorio.slice(0, 300);
  return (linha?.tipoAgendamento || lista?.tipo || "Agendamento").trim() || "Agendamento";
}

/**
 * Junta relatório + listas num agendamento por código. O relatório manda no
 * horário, na duração e no status (é a visão completa do período); a lista
 * completa com celular, sala e serviços.
 */
export function juntarAgendamentos(
  relatorio: LinhaDoRelatorio[],
  listas: AgendamentoDaLista[],
  timezone: string,
  catalogo: Map<string, TipoDeServico> = new Map(),
): AgendamentoImportado[] {
  const porCodigo = new Map<string, AgendamentoDaLista>();
  for (const l of listas) if (l.codConsulta) porCodigo.set(l.codConsulta, l);

  const codigos = new Set<string>();
  const saida: AgendamentoImportado[] = [];

  const montar = (codigo: string, linha: LinhaDoRelatorio | undefined, lista: AgendamentoDaLista | undefined) => {
    const data = dataDoBelle(linha?.dataAgendamento || lista?.dtAgenda || "");
    const hora = (linha?.horarioAgendamento || lista?.hrConsulta || "").trim();
    if (!data || !/^\d{2}:\d{2}$/.test(hora)) return;
    const minutos = linha?.minutosAgendamento && linha.minutosAgendamento > 0 ? linha.minutosAgendamento : DURACAO_PADRAO_MIN;
    const inicio = instanteDoMomentoLocal(data, hora, timezone);
    const statusExterno = (linha?.statusAgendamento || lista?.status || "").trim();
    saida.push({
      externalId: codigo,
      startsAt: inicio.toISOString(),
      endsAt: new Date(inicio.getTime() + minutos * 60_000).toISOString(),
      status: statusDoBelle(statusExterno),
      statusExterno,
      salaCodigo: lista?.sala?.cod || null,
      salaNome: (lista?.sala?.nome || linha?.salaAgendamento || "").trim(),
      titulo: tituloDe(lista, linha),
      notas: lista?.observacao ? lista.observacao.slice(0, 2000) : null,
      cliente: {
        codigo: (linha?.codigoCliente || lista?.cliente?.cod || "").trim(),
        nome: (lista?.cliente?.nome || linha?.nomeCliente || "").trim(),
        celular: (lista?.cliente?.celular || "").trim(),
      },
      tipo: tipoDoAgendamento(
        [...(lista?.servicos ?? []).map((s) => s.cod ?? ""), linha?.codigoServico ?? ""],
        linha?.tipoAgendamento || lista?.tipo || "",
        catalogo,
      ),
    });
  };

  for (const linha of relatorio) {
    if (!linha.idAgendamento || codigos.has(linha.idAgendamento)) continue;
    codigos.add(linha.idAgendamento);
    montar(linha.idAgendamento, linha, porCodigo.get(linha.idAgendamento));
  }
  // Marcado entre a leitura do relatório e a da lista: entra com a duração padrão.
  for (const [codigo, lista] of porCodigo) {
    if (!codigos.has(codigo)) montar(codigo, undefined, lista);
  }
  return saida;
}

/** Nome de sala comparável: "  Avaliação " e "avaliacao" são a mesma sala. */
export function chaveDoNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface ServicoDaAgenda {
  id: string;
  name: string;
  is_active: boolean;
}

/** "Depilação" → "Depilação a Laser"; "Avaliação" → "Avaliação". Nome contido, sem acento nem caixa. */
export function sugerirServico(rotulo: string, servicos: ServicoDaAgenda[]): string | null {
  const alvo = chaveDoNome(rotulo);
  if (!alvo) return null;
  const ativos = servicos.filter((s) => s.is_active);
  const exato = ativos.find((s) => chaveDoNome(s.name) === alvo);
  if (exato) return exato.id;
  const contidos = ativos.filter((s) => {
    const nome = chaveDoNome(s.name);
    return nome.includes(alvo) || alvo.includes(nome);
  });
  return contidos.length === 1 ? contidos[0]!.id : null;
}
