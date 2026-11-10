import { describe, expect, it } from "vitest";

import { blocosDe, emEspera, previsaoDosBlocos, quantosCabem } from "./blocos";

describe("espera programada em blocos", () => {
  it("sem os dois campos não há blocos", () => {
    expect(blocosDe({ bloco_tamanho: null, bloco_espera_minutos: null })).toBeNull();
    expect(blocosDe({ bloco_tamanho: 300, bloco_espera_minutos: null })).toBeNull();
    expect(blocosDe({ bloco_tamanho: 300, bloco_espera_minutos: 30 })).toEqual({ tamanho: 300, esperaMinutos: 30 });
  });

  it("⭐ o lote nunca atravessa a espera: faltando 2 para fechar o bloco, saem 2", () => {
    const cfg = { tamanho: 300, esperaMinutos: 30 };
    expect(quantosCabem(cfg, 298, 5)).toBe(2);
    expect(quantosCabem(cfg, 300, 5)).toBe(0);
    expect(quantosCabem(null, 9999, 5)).toBe(5);
  });

  it("está em espera só enquanto o horário de volta não chegou", () => {
    const agora = new Date("2026-11-10T15:00:00Z");
    expect(emEspera("2026-11-10T15:30:00Z", agora)).toBe(true);
    expect(emEspera("2026-11-10T14:59:00Z", agora)).toBe(false);
    expect(emEspera(null, agora)).toBe(false);
  });

  it("⭐ 1.000 contatos em blocos de 300 com 30 min: 4 blocos, 3 esperas", () => {
    const p = previsaoDosBlocos(1000, { tamanho: 300, esperaMinutos: 30 }, 1200);
    expect(p).toEqual({ blocos: 4, esperas: 3, minutos: 50 + 90 });
  });
});
