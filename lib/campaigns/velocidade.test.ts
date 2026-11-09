import { describe, expect, it } from "vitest";

import { CAMPAIGN_SEND_SPACING_MS } from "@/lib/automation/throttle";

import { RITMOS, ritmoDe, VELOCIDADE_PADRAO, VELOCIDADES_DA_CAMPANHA } from "./velocidade";

describe("ritmoDe", () => {
  it("⭐ o padrão é o ritmo de sempre: 1 mensagem por vez com a pausa antiga", () => {
    expect(VELOCIDADE_PADRAO).toBe("cuidadosa");
    expect(ritmoDe("cuidadosa")).toMatchObject({ lote: 1, pausaMs: CAMPAIGN_SEND_SPACING_MS });
  });

  it("valor desconhecido, nulo ou ausente anda cuidadoso — nunca no ritmo mais rápido", () => {
    for (const v of [null, undefined, "", "turbo", "RAPIDA"]) {
      expect(ritmoDe(v)).toBe(RITMOS.cuidadosa);
    }
  });

  it("cada velocidade é mais rápida que a anterior (mais por rodada, ou pausa menor)", () => {
    const vazao = VELOCIDADES_DA_CAMPANHA.map((v) => RITMOS[v].lote / (RITMOS[v].pausaMs + 1000));
    expect([...vazao].sort((a, b) => a - b)).toEqual(vazao);
    const porHora = VELOCIDADES_DA_CAMPANHA.map((v) => RITMOS[v].porHora);
    expect([...porHora].sort((a, b) => a - b)).toEqual(porHora);
  });
});
