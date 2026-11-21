/**
 * Peças comuns aos tradutores de AVISO (webhook) — Uno e Zandu. Funções puras.
 *
 * Os dois sistemas mandam o agendamento como objeto JSON; o que muda é o nome dos
 * campos. O que é igual (status em texto livre, telefone em qualquer campo, data
 * com ou sem fuso) mora aqui.
 */
import type { StatusDoCompromisso } from "@/lib/agenda/tipos";

import { chaveDoNome, DURACAO_PADRAO_MIN, type AgendamentoImportado, type TipoDeServico } from "./belle/traduzir";

/** Um aviso lido: o que é, de qual agendamento, e o agendamento pronto para a Agenda. */
export interface AvisoTraduzido {
  /** Nome do evento como veio ("APPOINTMENT_UPDATED"). */
  evento: string;
  /** Código do agendamento lá (null = não é aviso de agendamento). */
  externalId: string | null;
  /** Conta/empresa de origem (Uno: `schema`), quando o aviso diz. */
  conta: string | null;
  /** O agendamento pronto para a Agenda, ou null se não há o que aplicar. */
  item: AgendamentoImportado | null;
  /** Por que não há item (fica registrado no aviso). */
  motivo: string | null;
  /** Zandu: código da pessoa, para buscar o celular quando o aviso não traz. */
  pessoaId?: string | null;
}

/** Objeto JSON qualquer (o aviso não tem schema garantido). */
export type Objeto = Record<string, unknown>;

export function objeto(v: unknown): Objeto | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Objeto) : null;
}

/** Primeiro valor de texto/número não vazio entre as chaves, como texto. */
export function texto(o: Objeto | null | undefined, ...chaves: string[]): string {
  if (!o) return "";
  for (const c of chaves) {
    const v = o[c];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** `{ id, name }` ou texto solto → nome. */
export function nomeDe(v: unknown): string {
  if (typeof v === "string") return v.trim();
  return texto(objeto(v), "name", "nome", "label", "title");
}

/**
 * Status em texto livre → status da Agenda. Uno e Zandu deixam a clínica nomear
 * os próprios status ("Agendado", "Check-in", "Falta"…): casa por radical, e o
 * desconhecido vira "Agendado" — nunca some da Agenda por causa de um nome novo.
 */
export function statusPorTexto(statusExterno: string): StatusDoCompromisso {
  const s = chaveDoNome(statusExterno);
  if (!s || /nao confirm|a confirmar|aguardando confirm/.test(s)) return "pending";
  if (/cancel|desmarc|remov|exclu|apagad/.test(s)) return "cancelled";
  if (/falt|faltou|nao compareceu|no.?show|ausen/.test(s)) return "no_show";
  if (/atendid|finaliz|conclu|realizad/.test(s)) return "completed";
  if (/confirm|check|chegou|em atendimento|em andamento|presen/.test(s)) return "confirmed";
  return "pending";
}

/** Celular em qualquer campo com cara de telefone (o primeiro preenchido). */
export function telefoneNoObjeto(o: Objeto | null | undefined): string {
  if (!o) return "";
  const chaves = Object.keys(o).filter((k) => /cel|phone|fone|whats|mobile/i.test(k) && !/2$/.test(k));
  // "cellPhone"/"celular" antes de "phone": o fixo da recepção não é o WhatsApp da paciente.
  chaves.sort((a, b) => Number(!/cel|mobile|whats/i.test(a)) - Number(!/cel|mobile|whats/i.test(b)));
  for (const k of chaves) {
    const v = o[k];
    if ((typeof v === "string" || typeof v === "number") && String(v).replace(/\D/g, "").length >= 8) return String(v);
  }
  return "";
}

/**
 * Data do aviso → instante ISO. Com fuso ("-03:00", "Z") vale o fuso; SEM fuso,
 * vale `semFuso`: o Uno manda com fuso; o Zandu documenta UTC sem o "Z".
 */
export function instante(valor: string, semFuso: "utc" | "invalido" = "invalido"): string | null {
  const v = valor.trim();
  if (!v) return null;
  const temFuso = /(Z|[+-]\d{2}:?\d{2})$/i.test(v);
  if (!temFuso && semFuso === "invalido") return null;
  const d = new Date(temFuso ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function fimOuPadrao(inicioIso: string, fimIso: string | null, minutos?: number | null): string {
  if (fimIso && new Date(fimIso) > new Date(inicioIso)) return fimIso;
  const m = minutos && minutos > 0 ? minutos : DURACAO_PADRAO_MIN;
  return new Date(new Date(inicioIso).getTime() + m * 60_000).toISOString();
}

/** Nome do serviço → tipo (a chave é o nome, como no Belle: códigos repetem nome). */
export function tipoDoServico(nome: string): TipoDeServico | null {
  const chave = chaveDoNome(nome);
  return chave ? { chave: `servico:${chave}`, rotulo: nome.trim() } : null;
}
