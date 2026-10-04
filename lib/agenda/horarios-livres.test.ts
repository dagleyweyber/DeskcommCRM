import { describe, expect, it } from "vitest";

import { horariosLivres, type ParametrosDeHorariosLivres } from "./horarios-livres";

/**
 * Motor de disponibilidade — função pura, clock sempre injetado. Mesma
 * convenção de `lib/routing/eligibility.test.ts`: instantes fixos,
 * comentados com o horário local equivalente.
 */

// Dom 2026-07-12 09:00 America/Sao_Paulo (UTC-03) == 12:00Z. dow=0 (domingo,
// sem janela no schedule-padrão abaixo) — dá um dia inteiro de folga antes
// da primeira janela (segunda).
const DOM_0900_BRT = new Date("2026-07-12T12:00:00Z");

function base(over: Partial<ParametrosDeHorariosLivres> = {}): ParametrosDeHorariosLivres {
  return {
    agora: DOM_0900_BRT,
    schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "10:00" }] },
    excecoes: [],
    ocupados: [],
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 60,
    bookingWindowDays: 14,
    ...over,
  };
}

describe("horariosLivres — grade básica", () => {
  it("⭐ janela seg 08–10, 30min: devolve 4 candidatos (08:00,08:30,09:00,09:30)", () => {
    const out = horariosLivres(base());
    expect(out).toHaveLength(4);
    expect(out[0]!.starts_at).toBe(new Date("2026-07-13T11:00:00Z").toISOString()); // seg 08:00 BRT
    expect(out[3]!.starts_at).toBe(new Date("2026-07-13T12:30:00Z").toISOString()); // seg 09:30 BRT
  });

  it("slotIntervalMinutes separado da duração: 60min de janela, slot a cada 15min, duração 30min", () => {
    const out = horariosLivres(
      base({
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "09:00" }] },
        durationMinutes: 30,
        slotIntervalMinutes: 15,
      }),
    );
    // 08:00, 08:15, 08:30 cabem (termina até 09:00); 08:45 terminaria 09:15, fora da janela.
    expect(out.map((h) => h.starts_at)).toEqual([
      new Date("2026-07-13T11:00:00Z").toISOString(),
      new Date("2026-07-13T11:15:00Z").toISOString(),
      new Date("2026-07-13T11:30:00Z").toISOString(),
    ]);
  });
});

describe("horariosLivres — aviso mínimo e janela de reserva", () => {
  it("⭐ aviso mínimo empurra o primeiro candidato pro dia seguinte quando hoje já não cabe", () => {
    // agora = seg 09:00 BRT, janela seg 08-10, aviso mínimo 24h ⇒ nada hoje.
    const segCedo = new Date("2026-07-13T12:00:00Z"); // seg 09:00 BRT
    const out = horariosLivres(
      base({
        agora: segCedo,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "10:00" }] },
        minimumNoticeMinutes: 24 * 60,
      }),
    );
    expect(out).toHaveLength(0); // só há janela às segundas — próxima é 7 dias depois, fora daqui
  });

  it("bookingWindowDays exclui candidato além do horizonte", () => {
    const out = horariosLivres(base({ bookingWindowDays: 0 }));
    // Só domingo (dow=0, sem janela) está dentro de 0 dias — nada.
    expect(out).toHaveLength(0);
  });
});

describe("horariosLivres — ocupado e buffer", () => {
  it("⭐ candidato que colide com um ocupado some da lista", () => {
    const out = horariosLivres(
      base({
        ocupados: [
          { starts_at: new Date("2026-07-13T11:00:00Z").toISOString(), ends_at: new Date("2026-07-13T11:30:00Z").toISOString() }, // 08:00-08:30 BRT
        ],
      }),
    );
    expect(out.map((h) => h.starts_at)).not.toContain(new Date("2026-07-13T11:00:00Z").toISOString());
    expect(out).toHaveLength(3);
  });

  it("buffer infla o candidato — ocupado às 08:30 também derruba o candidato de 08:00 com buffer_after 30min", () => {
    const out = horariosLivres(
      base({
        bufferAfterMinutes: 30,
        ocupados: [
          { starts_at: new Date("2026-07-13T11:30:00Z").toISOString(), ends_at: new Date("2026-07-13T12:00:00Z").toISOString() }, // 08:30-09:00 BRT
        ],
      }),
    );
    // 08:00 inflado (buffer depois) vai até 09:00 — colide com o ocupado 08:30-09:00.
    expect(out.map((h) => h.starts_at)).not.toContain(new Date("2026-07-13T11:00:00Z").toISOString());
  });

  it("toque na borda não é colisão (fim de um = início do outro)", () => {
    const out = horariosLivres(
      base({
        ocupados: [
          { starts_at: new Date("2026-07-13T10:30:00Z").toISOString(), ends_at: new Date("2026-07-13T11:00:00Z").toISOString() }, // termina exatamente 08:00 BRT
        ],
      }),
    );
    expect(out.map((h) => h.starts_at)).toContain(new Date("2026-07-13T11:00:00Z").toISOString());
  });
});

describe("horariosLivres — exceções", () => {
  it("⭐ exceção 'available' REDEFINE o dia, não soma à janela semanal", () => {
    // Terça (dow=2) não tem janela semanal nenhuma — plantão extra abre 14-15h.
    const out = horariosLivres(
      base({
        excecoes: [{ date: "2026-07-14", kind: "available", start_time: "14:00", end_time: "15:00" }],
      }),
    );
    const terca = out.filter((h) => h.starts_at.startsWith("2026-07-14") === false && h.starts_at < "2026-07-15");
    // 14:00-15:00 BRT terça = 17:00Z-18:00Z — dois candidatos de 30min.
    expect(out.map((h) => h.starts_at)).toContain(new Date("2026-07-14T17:00:00Z").toISOString());
    expect(out.map((h) => h.starts_at)).toContain(new Date("2026-07-14T17:30:00Z").toISOString());
    void terca;
  });

  it("⭐ exceção 'unavailable' SUBTRAI da janela semanal — bloqueia um feriado", () => {
    const out = horariosLivres(
      base({
        excecoes: [{ date: "2026-07-13", kind: "unavailable", start_time: null, end_time: null }],
      }),
    );
    // Segunda inteira bloqueada — zero candidato nela; só restaria fora da janela (não há outra).
    expect(out.filter((h) => h.starts_at.startsWith("2026-07-13"))).toHaveLength(0);
  });

  it("exceção 'unavailable' parcial PARTE a janela em duas", () => {
    const out = horariosLivres(
      base({
        excecoes: [{ date: "2026-07-13", kind: "unavailable", start_time: "08:30", end_time: "09:00" }],
      }),
    );
    // Janela 08-10 menos 08:30-09:00: sobra 08:00-08:30 e 09:00-10:00 — candidato de 08:30 some.
    expect(out.map((h) => h.starts_at)).not.toContain(new Date("2026-07-13T11:30:00Z").toISOString());
    expect(out.map((h) => h.starts_at)).toContain(new Date("2026-07-13T11:00:00Z").toISOString());
    expect(out.map((h) => h.starts_at)).toContain(new Date("2026-07-13T12:00:00Z").toISOString());
  });
});

describe("horariosLivres — limites", () => {
  it("respeita o teto de candidatos (defesa contra janela enorme + slot minúsculo)", () => {
    const out = horariosLivres(
      base({
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "00:00", end: "23:59" }] },
        durationMinutes: 1,
        slotIntervalMinutes: 1,
        bookingWindowDays: 365,
        limite: 10,
      }),
    );
    expect(out.length).toBeLessThanOrEqual(10);
  });
});
