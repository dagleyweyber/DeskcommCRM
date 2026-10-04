/**
 * Conversão de fuso horário pro motor de disponibilidade — só `Intl`
 * (stdlib), sem dependência nova (o repo tem `date-fns`, que não é
 * tz-aware). Mesma técnica de `lib/routing/eligibility.ts`'s `localMoment`
 * (privada lá), estendida pra converter civil↔instante nos dois sentidos —
 * a elegibilidade só precisa de "now → dow/hhmm local"; a grade precisa
 * também do inverso, pra gerar os candidatos de horário.
 *
 * Limite conhecido e aceito: a hora exata da virada de DST (uma janela de
 * ~1h, duas vezes por ano, em fusos que observam DST) pode gerar um
 * instante ligeiramente deslocado numa única passada de aproximação — grão
 * normal de agendamento (5-60min) nunca se aproxima dessa margem na prática.
 * Não vale a complexidade de uma segunda passada pra um caso que nenhum
 * cliente real (Brasil, sem DST desde 2019) alcança hoje.
 */

const DIA_DA_SEMANA: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface MomentoLocal {
  /** 0=domingo … 6=sábado. */
  dow: number;
  /** "YYYY-MM-DD" no fuso dado. */
  data: string;
  /** "HH:MM" no fuso dado. */
  hhmm: string;
}

/** `RangeError` se o fuso não existe — a mesma defesa que `fusoValido` (lib/schemas/routing.ts) já aplica na escrita. */
export function fusoValido(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** O momento civil (dow + data + HH:MM) de um instante, no fuso dado. */
export function momentoLocal(instante: Date, timezone: string): MomentoLocal {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    dow: DIA_DA_SEMANA[get("weekday")] ?? 0,
    data: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${get("hour")}:${get("minute")}`,
  };
}

/**
 * O instante UTC de um momento civil ("YYYY-MM-DD", "HH:MM") num fuso dado.
 *
 * Técnica de dupla formatação: trata o horário civil como se já fosse UTC
 * (um "chute"), formata esse chute NO FUSO ALVO pra ver que horário civil
 * ele mostra lá, e corrige pela diferença — é o que `date-fns-tz`
 * (`zonedTimeToUtc`, versões <5) faz por baixo, sem precisar da dependência
 * pra um só caso de uso.
 */
export function instanteDoMomentoLocal(data: string, hhmm: string, timezone: string): Date {
  const [ano, mes, dia] = data.split("-").map(Number);
  const [hora, minuto] = hhmm.split(":").map(Number);
  const chuteUtcMs = Date.UTC(ano!, mes! - 1, dia!, hora!, minuto!, 0);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(chuteUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const mostradoUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = mostradoUtcMs - chuteUtcMs;
  return new Date(chuteUtcMs - offsetMs);
}

/** `"YYYY-MM-DD"` de hoje (ou de `base`) no fuso dado — base pra andar dia a dia na janela de reserva. */
export function dataLocalDe(base: Date, timezone: string): string {
  return momentoLocal(base, timezone).data;
}

/** Soma `dias` a uma data `"YYYY-MM-DD"` civil, sem depender de fuso (aritmética de calendário pura). */
export function somaDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  const d = new Date(Date.UTC(ano!, mes! - 1, dia! + dias));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
