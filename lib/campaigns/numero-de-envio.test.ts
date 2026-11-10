import { describe, expect, it } from "vitest";

import { avisoDoNumero, numeroInicial, rotuloDoNumero, textoDoLimite, type NumeroDeEnvio } from "./numero-de-envio";

const n = (extra: Partial<NumeroDeEnvio> = {}): NumeroDeEnvio => ({
  id: "a",
  nome: "Loja Centro",
  conectado: true,
  qualidade: "GREEN",
  limite: "TIER_1K",
  ...extra,
});

describe("numeroInicial", () => {
  it("⭐ só vem escolhido quando há UM número; com vários a escolha é do operador", () => {
    expect(numeroInicial([n()])).toBe("a");
    expect(numeroInicial([n(), n({ id: "b" })])).toBeNull();
    expect(numeroInicial([])).toBeNull();
  });
});

describe("avisoDoNumero", () => {
  it("desconectado bloqueia", () => {
    expect(avisoDoNumero(n({ conectado: false }))?.nivel).toBe("bloqueio");
  });

  it("⭐ nota vermelha é risco (diz que a campanha para sozinha); amarela é atenção; verde e sem nota não dizem nada", () => {
    expect(avisoDoNumero(n({ qualidade: "RED" }))).toMatchObject({ nivel: "risco", texto: expect.stringContaining("para sozinha") });
    expect(avisoDoNumero(n({ qualidade: "YELLOW" }))?.nivel).toBe("atencao");
    expect(avisoDoNumero(n({ qualidade: "GREEN" }))).toBeNull();
    expect(avisoDoNumero(n({ qualidade: null }))).toBeNull();
    expect(avisoDoNumero(null)).toBeNull();
  });

  it("desconectado vem antes da nota", () => {
    expect(avisoDoNumero(n({ conectado: false, qualidade: "RED" }))?.nivel).toBe("bloqueio");
  });
});

describe("rotuloDoNumero / textoDoLimite", () => {
  it("monta o rótulo com a saúde, e sem dado fica só o nome", () => {
    expect(rotuloDoNumero(n({ qualidade: "YELLOW", limite: "TIER_250" }))).toBe(
      "Loja Centro — qualidade média · até 250 contatos por dia",
    );
    expect(rotuloDoNumero(n({ qualidade: null, limite: null }))).toBe("Loja Centro");
    expect(rotuloDoNumero(n({ conectado: false, qualidade: null, limite: null }))).toBe("Loja Centro — desconectado");
  });

  it("limite em português", () => {
    expect(textoDoLimite("TIER_10K")).toBe("até 10.000 contatos diferentes a cada 24 h");
    expect(textoDoLimite("TIER_UNLIMITED")).toBe("sem limite diário de contatos");
    expect(textoDoLimite(null)).toBeNull();
  });
});
