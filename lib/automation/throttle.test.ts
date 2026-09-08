import { describe, it, expect } from "vitest";
import { withinSendWindow, nextWindowStart, jitterMs } from "@/lib/automation/throttle";

/**
 * A janela é medida em America/Sao_Paulo (UTC-3, sem DST desde 2019 — offset
 * estável o ano inteiro). Todo instante aqui é UTC explícito (`Z`) pra não
 * depender do fuso de quem roda o teste — achado ao vivo: o instante anterior
 * (`new Date("...")` sem `Z`) é interpretado no fuso do PROCESSO, e a VPS
 * roda em UTC, o que mascarava exatamente o bug que este arquivo hoje evita.
 */
describe("withinSendWindow — hora de parede em America/Sao_Paulo, não do servidor", () => {
  it("10h BRT (13h UTC) → true", () => expect(withinSendWindow(new Date("2026-07-17T13:00:00Z"))).toBe(true));
  it("06:59 BRT (09:59 UTC) → false", () => expect(withinSendWindow(new Date("2026-07-17T09:59:00Z"))).toBe(false));
  it("22:00 BRT (01:00 UTC do dia seguinte) → false (janela é [7,22))", () =>
    expect(withinSendWindow(new Date("2026-07-18T01:00:00Z"))).toBe(false));
  it("⭐ 22:00 UTC (19h BRT) → TRUE — é o caso que a hora do servidor errava", () => {
    // Achado ao vivo pela campanha em massa: a VPS roda em UTC, e 22h UTC
    // ainda é 19h em Brasília — dentro da janela. Medir em hora de servidor
    // fechava a janela três horas cedo demais.
    expect(withinSendWindow(new Date("2026-07-17T22:00:00Z"))).toBe(true);
  });
});

describe("nextWindowStart — sempre 7h em America/Sao_Paulo, como instante UTC", () => {
  it("às 23h BRT retorna 7h BRT de AMANHÃ (10h UTC)", () => {
    // 23h BRT do dia 17 = 02:00 UTC do dia 18 — "amanhã" é dia 18.
    const next = nextWindowStart(new Date("2026-07-18T02:00:00Z"));
    expect(next).toBe(new Date("2026-07-18T10:00:00.000Z").toISOString());
  });
  it("às 5h BRT retorna 7h BRT de HOJE (10h UTC do mesmo dia)", () => {
    // 5h BRT = 08:00 UTC do mesmo dia.
    const next = nextWindowStart(new Date("2026-07-17T08:00:00Z"));
    expect(next).toBe(new Date("2026-07-17T10:00:00.000Z").toISOString());
  });
});

describe("jitterMs", () => {
  it("sempre em [0, 800]", () => {
    for (let i = 0; i < 50; i++) {
      const j = jitterMs();
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(800);
    }
  });
});
