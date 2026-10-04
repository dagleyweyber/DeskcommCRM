/**
 * O motor de disponibilidade — função PURA (sem banco, sem relógio implícito:
 * `agora` é sempre injetado, mesmo padrão de `lib/routing/eligibility.ts`).
 * `lib/agenda/consulta.ts` é quem busca os dados e chama isto; a UI
 * (`GET /api/v1/agenda/horarios-livres`) e a ferramenta MCP do agente de IA
 * chamam o MESMO consulta.ts — a IA nunca pode oferecer um horário que a
 * tela não mostraria.
 *
 * Algoritmo (ordem importa):
 *  1. Anda dia a dia, do dia civil de hoje (no fuso do schedule) até
 *     `booking_window_days` à frente.
 *  2. Pra cada dia: as janelas da semana (`schedule.windows` filtradas por
 *     `dow`) são SUBSTITUÍDAS (não somadas) por uma exceção `available`
 *     daquele dia, se existir — um plantão extra redefine o dia inteiro, não
 *     se soma à jornada normal. Depois, exceções `unavailable` SUBTRAEM.
 *  3. Janelas sobrepostas são fundidas.
 *  4. Uma grade FIXA anda do início de cada janela em passos de
 *     `slotIntervalMinutes` (ou `durationMinutes`, se nulo) — a grade nunca
 *     se desloca, só perde candidato.
 *  5. Cada candidato é inflado por `bufferBefore`/`bufferAfter` e testado
 *     contra a lista de ocupados (`colide`).
 *  6. Candidato antes de `agora + minimumNotice` ou depois de
 *     `agora + bookingWindowDays` cai fora.
 *
 * Travessia de meia-noite dentro de uma janela (`22:00`–`02:00`) é NÃO-feature
 * nesta fase, de propósito: nenhum caso real pedido usa isso, e modelar
 * exige decidir em QUAL dia civil a janela "pertence" — complexidade sem
 * cliente hoje (DIRC: calcular quando precisar).
 */
import type { AvailabilitySchedule, ScheduleWindow } from "@/lib/schemas/routing";
import { instanteDoMomentoLocal, momentoLocal, dataLocalDe, somaDias } from "./fuso";
import { candidatoOcupado } from "./ocupados";
import type { HorarioLivre, IntervaloOcupado } from "./tipos";

export interface ExcecaoDeDisponibilidade {
  date: string;
  kind: "available" | "unavailable";
  start_time: string | null;
  end_time: string | null;
}

export interface ParametrosDeHorariosLivres {
  agora: Date;
  schedule: Pick<AvailabilitySchedule, "timezone" | "windows">;
  excecoes: ExcecaoDeDisponibilidade[];
  ocupados: IntervaloOcupado[];
  durationMinutes: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  /** Teto de candidatos devolvidos — defesa contra janela enorme + slot minúsculo. */
  limite?: number;
}

interface JanelaDoDia {
  /** Minutos desde 00:00 local do dia. */
  inicio: number;
  fim: number;
}

function hhmmParaMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function minutosParaHhmm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Funde janelas sobrepostas/adjacentes, em ordem. */
function fundeJanelas(janelas: JanelaDoDia[]): JanelaDoDia[] {
  if (janelas.length === 0) return [];
  const ordenadas = [...janelas].sort((a, b) => a.inicio - b.inicio);
  const fundidas: JanelaDoDia[] = [ordenadas[0]!];
  for (const j of ordenadas.slice(1)) {
    const ultima = fundidas[fundidas.length - 1]!;
    if (j.inicio <= ultima.fim) {
      ultima.fim = Math.max(ultima.fim, j.fim);
    } else {
      fundidas.push({ ...j });
    }
  }
  return fundidas;
}

/** Subtrai `menos` de `janelas` — pode partir uma janela em duas. */
function subtraiJanela(janelas: JanelaDoDia[], menos: JanelaDoDia): JanelaDoDia[] {
  const resultado: JanelaDoDia[] = [];
  for (const j of janelas) {
    if (menos.fim <= j.inicio || menos.inicio >= j.fim) {
      resultado.push(j);
      continue;
    }
    if (menos.inicio > j.inicio) resultado.push({ inicio: j.inicio, fim: Math.min(menos.inicio, j.fim) });
    if (menos.fim < j.fim) resultado.push({ inicio: Math.max(menos.fim, j.inicio), fim: j.fim });
  }
  return resultado;
}

/** As janelas de trabalho de UM dia civil, já com exceções aplicadas (passo 2 do cabeçalho). */
function janelasDoDia(dow: number, windows: ScheduleWindow[], excecoesDoDia: ExcecaoDeDisponibilidade[]): JanelaDoDia[] {
  const disponivel = excecoesDoDia.find((e) => e.kind === "available");

  let janelas: JanelaDoDia[];
  if (disponivel) {
    // Exceção 'available' REDEFINE o dia — não soma à jornada semanal.
    janelas =
      disponivel.start_time && disponivel.end_time
        ? [{ inicio: hhmmParaMinutos(disponivel.start_time), fim: hhmmParaMinutos(disponivel.end_time) }]
        : [{ inicio: 0, fim: 24 * 60 }];
  } else {
    janelas = windows.filter((w) => w.dow === dow).map((w) => ({ inicio: hhmmParaMinutos(w.start), fim: hhmmParaMinutos(w.end) }));
  }

  janelas = fundeJanelas(janelas);

  for (const exc of excecoesDoDia) {
    if (exc.kind !== "unavailable") continue;
    const bloqueio: JanelaDoDia =
      exc.start_time && exc.end_time
        ? { inicio: hhmmParaMinutos(exc.start_time), fim: hhmmParaMinutos(exc.end_time) }
        : { inicio: 0, fim: 24 * 60 };
    janelas = subtraiJanela(janelas, bloqueio);
  }

  return janelas;
}

export function horariosLivres(p: ParametrosDeHorariosLivres): HorarioLivre[] {
  const timezone = p.schedule.timezone || "America/Sao_Paulo";
  const windows = p.schedule.windows ?? [];
  const passoMinutos = p.slotIntervalMinutes ?? p.durationMinutes;
  const limite = p.limite ?? 200;

  const limiteInferior = new Date(p.agora.getTime() + p.minimumNoticeMinutes * 60_000);
  const limiteSuperiorData = somaDias(dataLocalDe(p.agora, timezone), p.bookingWindowDays);

  const porData = new Map<string, ExcecaoDeDisponibilidade[]>();
  for (const e of p.excecoes) {
    const lista = porData.get(e.date) ?? [];
    lista.push(e);
    porData.set(e.date, lista);
  }

  const candidatos: HorarioLivre[] = [];
  let dataAtual = dataLocalDe(p.agora, timezone);

  for (let dias = 0; dias <= p.bookingWindowDays && candidatos.length < limite; dias++) {
    if (dataAtual > limiteSuperiorData) break;

    // dow a partir da própria data civil (evita um segundo cálculo de fuso).
    const [ano, mes, dia] = dataAtual.split("-").map(Number);
    const dow = new Date(Date.UTC(ano!, mes! - 1, dia!)).getUTCDay();

    const janelas = janelasDoDia(dow, windows, porData.get(dataAtual) ?? []);

    for (const janela of janelas) {
      for (let inicioMin = janela.inicio; inicioMin + p.durationMinutes <= janela.fim; inicioMin += passoMinutos) {
        if (candidatos.length >= limite) break;

        const inicioHhmm = minutosParaHhmm(inicioMin);
        const fimHhmm = minutosParaHhmm(inicioMin + p.durationMinutes);
        const startsAt = instanteDoMomentoLocal(dataAtual, inicioHhmm, timezone);
        const endsAt = instanteDoMomentoLocal(dataAtual, fimHhmm, timezone);

        if (startsAt < limiteInferior) continue;
        if (startsAt > new Date(Date.UTC(ano!, mes! - 1, dia! + p.bookingWindowDays + 1))) continue;

        const infladoInicio = new Date(startsAt.getTime() - p.bufferBeforeMinutes * 60_000);
        const infladoFim = new Date(endsAt.getTime() + p.bufferAfterMinutes * 60_000);
        const candidatoInflado: IntervaloOcupado = {
          starts_at: infladoInicio.toISOString(),
          ends_at: infladoFim.toISOString(),
        };

        if (candidatoOcupado(candidatoInflado, p.ocupados)) continue;

        candidatos.push({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() });
      }
    }

    dataAtual = somaDias(dataAtual, 1);
  }

  return candidatos;
}

/** Momento civil de um instante — reexport fino pra quem só precisa disso (ex.: decorar a grade). */
export { momentoLocal };
