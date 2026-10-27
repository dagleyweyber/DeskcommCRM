/**
 * Geometria da grade da Agenda (uma coluna por sala) — funções PURAS, sem
 * React e sem relógio implícito, pra serem testadas sem montar tela.
 *
 * Tudo em "minutos desde 00:00" no fuso da CLÍNICA (`horario_padrao.timezone`),
 * nunca no fuso do navegador: a recepcionista abrindo a agenda de outro
 * estado continua vendo 08:00 onde a clínica abre às 08:00.
 */
import { momentoLocal } from "./fuso";
import type { HorarioDeFuncionamento, Sala } from "./tipos";

export interface Faixa {
  inicio: number;
  fim: number;
}

export interface BloqueioDoDia {
  room_id: string | null;
  start_time: string | null;
  end_time: string | null;
}

export function hhmmParaMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutosParaHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Dia da semana (0=domingo) de uma data civil "YYYY-MM-DD", sem fuso. */
export function diaDaSemana(data: string): number {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay();
}

/** Minutos desde 00:00 (fuso da clínica) de um instante ISO. */
export function minutosNoDia(iso: string, timezone: string): number {
  return hhmmParaMinutos(momentoLocal(new Date(iso), timezone).hhmm);
}

/** Data civil (fuso da clínica) de um instante ISO. */
export function dataNoFuso(iso: string, timezone: string): string {
  return momentoLocal(new Date(iso), timezone).data;
}

/** Horário efetivo da sala: o próprio, ou o padrão da clínica. */
export function horarioDaSala(sala: Pick<Sala, "schedule">, padrao: HorarioDeFuncionamento): HorarioDeFuncionamento {
  return sala.schedule ?? padrao;
}

/** Janelas ABERTAS da sala num dia, já sem os bloqueios (da sala e da clínica inteira). */
export function janelasAbertas(
  sala: Pick<Sala, "id" | "schedule">,
  padrao: HorarioDeFuncionamento,
  data: string,
  bloqueios: BloqueioDoDia[],
): Faixa[] {
  const dow = diaDaSemana(data);
  let janelas: Faixa[] = horarioDaSala(sala, padrao)
    .windows.filter((w) => w.dow === dow)
    .map((w) => ({ inicio: hhmmParaMinutos(w.start), fim: hhmmParaMinutos(w.end) }))
    .sort((a, b) => a.inicio - b.inicio);

  for (const b of bloqueios) {
    if (b.room_id !== null && b.room_id !== sala.id) continue;
    const corte: Faixa =
      b.start_time && b.end_time
        ? { inicio: hhmmParaMinutos(b.start_time), fim: hhmmParaMinutos(b.end_time) }
        : { inicio: 0, fim: 24 * 60 };
    const proximas: Faixa[] = [];
    for (const j of janelas) {
      if (corte.fim <= j.inicio || corte.inicio >= j.fim) {
        proximas.push(j);
        continue;
      }
      if (corte.inicio > j.inicio) proximas.push({ inicio: j.inicio, fim: corte.inicio });
      if (corte.fim < j.fim) proximas.push({ inicio: corte.fim, fim: j.fim });
    }
    janelas = proximas;
  }
  return janelas;
}

/** Texto do topo da coluna ("08–21h", "Fechada"), pelo horário semanal — sem bloqueio pontual. */
export function rotuloDoHorario(sala: Pick<Sala, "schedule">, padrao: HorarioDeFuncionamento, data: string): string {
  const dow = diaDaSemana(data);
  const janelas = horarioDaSala(sala, padrao).windows.filter((w) => w.dow === dow);
  if (janelas.length === 0) return "Fechada";
  const inicio = Math.min(...janelas.map((w) => hhmmParaMinutos(w.start)));
  const fim = Math.max(...janelas.map((w) => hhmmParaMinutos(w.end)));
  const fmt = (m: number) => (m % 60 === 0 ? String(m / 60).padStart(2, "0") : minutosParaHhmm(m));
  return `${fmt(inicio)}–${fmt(fim)}h`;
}

/**
 * Faixa vertical da grade no dia: do primeiro horário de abertura ao último
 * fechamento entre as salas visíveis, alargada para caber compromissos fora
 * do horário (um encaixe antigo não pode sumir da tela). Arredonda para hora
 * cheia. Sem nada aberto, mostra 08–18.
 */
export function faixaDaGrade(
  salas: Pick<Sala, "schedule">[],
  padrao: HorarioDeFuncionamento,
  data: string,
  compromissos: Faixa[],
): Faixa {
  const dow = diaDaSemana(data);
  const pontos: number[] = [];
  for (const s of salas) {
    for (const w of horarioDaSala(s, padrao).windows) {
      if (w.dow !== dow) continue;
      pontos.push(hhmmParaMinutos(w.start), hhmmParaMinutos(w.end));
    }
  }
  for (const c of compromissos) pontos.push(c.inicio, c.fim);
  if (pontos.length === 0) return { inicio: 8 * 60, fim: 18 * 60 };
  const inicio = Math.floor(Math.min(...pontos) / 60) * 60;
  const fim = Math.min(24 * 60, Math.ceil(Math.max(...pontos) / 60) * 60);
  return { inicio, fim: Math.max(fim, inicio + 60) };
}

/** Matriz do mini-calendário: 6 semanas (42 dias) começando no domingo da semana do dia 1. */
export function semanasDoMes(ano: number, mes0: number): string[] {
  const primeiro = new Date(Date.UTC(ano, mes0, 1));
  const inicio = new Date(Date.UTC(ano, mes0, 1 - primeiro.getUTCDay()));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(inicio.getTime() + i * 86_400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  });
}
