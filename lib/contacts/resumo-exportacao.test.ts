import { describe, expect, it } from "vitest";

import { fraseDaExportacao } from "./resumo-exportacao";

describe("fraseDaExportacao", () => {
  it("a exportação de conversas não informa contagem: não há o que dizer", () => {
    expect(fraseDaExportacao(null, 0)).toBeNull();
  });

  it("sem ninguém de fora, só diz quantos saíram", () => {
    expect(fraseDaExportacao(1500, 0)).toEqual({ titulo: "1.500 contatos exportados.", detalhe: null });
  });

  it("singular", () => {
    expect(fraseDaExportacao(1, 0)?.titulo).toBe("1 contato exportado.");
  });

  it("⭐ quando há gente sem número, diz QUANTAS e POR QUÊ — o arquivo não é 'todo mundo'", () => {
    const f = fraseDaExportacao(1500, 2249);
    expect(f?.titulo).toBe("1.500 contatos exportados.");
    expect(f?.detalhe).toMatch(/2\.249 pessoas ficaram de fora/);
    expect(f?.detalhe).toMatch(/código interno/);
  });

  it("uma pessoa de fora, no singular", () => {
    expect(fraseDaExportacao(10, 1)?.detalhe).toMatch(/Outras 1 pessoa ficou de fora/);
  });

  it("cabeçalho ausente (NaN) não vira 'NaN contatos'", () => {
    expect(fraseDaExportacao(Number.NaN, 5)).toBeNull();
  });
});
