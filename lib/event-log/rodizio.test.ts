import { describe, expect, it } from "vitest";

import { intercalaPorOrganizacao } from "./rodizio";

/** Linha mínima: só o que a função olha, mais um rótulo para conferir ordem. */
function linha(org: string, rotulo: string): { organization_id: string; rotulo: string } {
  return { organization_id: org, rotulo };
}

describe("intercalaPorOrganizacao", () => {
  it("⭐ clínica com 1 evento não espera a clínica com muitos (o defeito original)", () => {
    // Cenário real: a org A despejou 5 eventos ANTES de B e C existirem na
    // fila. Sem rodízio, A consumiria o tick inteiro e B/C esperariam.
    const linhas = [
      linha("A", "a1"),
      linha("A", "a2"),
      linha("A", "a3"),
      linha("A", "a4"),
      linha("A", "a5"),
      linha("B", "b1"),
      linha("C", "c1"),
    ];

    const saida = intercalaPorOrganizacao(linhas, 3).map((l) => l.rotulo);

    expect(saida).toEqual(["a1", "b1", "c1"]);
  });

  it("preserva a ordem DENTRO de cada organização (a que importa de verdade)", () => {
    const linhas = [
      linha("A", "a1"),
      linha("B", "b1"),
      linha("A", "a2"),
      linha("B", "b2"),
      linha("A", "a3"),
    ];

    const saida = intercalaPorOrganizacao(linhas, 10);

    const soA = saida.filter((l) => l.organization_id === "A").map((l) => l.rotulo);
    const soB = saida.filter((l) => l.organization_id === "B").map((l) => l.rotulo);
    expect(soA).toEqual(["a1", "a2", "a3"]);
    expect(soB).toEqual(["b1", "b2"]);
  });

  it("uma organização só: comportamento IDÊNTICO ao de antes (não regride quem tem 1 cliente)", () => {
    const linhas = [linha("A", "a1"), linha("A", "a2"), linha("A", "a3")];

    expect(intercalaPorOrganizacao(linhas, 2).map((l) => l.rotulo)).toEqual(["a1", "a2"]);
  });

  it("quem esperou mais abre a rodada (desempate pela ordem de chegada)", () => {
    const linhas = [linha("B", "b1"), linha("A", "a1"), linha("B", "b2"), linha("A", "a2")];

    // B apareceu primeiro na lista (evento mais antigo), então abre as rodadas.
    expect(intercalaPorOrganizacao(linhas, 4).map((l) => l.rotulo)).toEqual([
      "b1",
      "a1",
      "b2",
      "a2",
    ]);
  });

  it("menos linhas que o teto: devolve todas, sem laço infinito", () => {
    const linhas = [linha("A", "a1"), linha("B", "b1")];

    expect(intercalaPorOrganizacao(linhas, 50)).toHaveLength(2);
  });

  it("entrada vazia e teto zero/negativo devolvem lista vazia", () => {
    expect(intercalaPorOrganizacao([], 10)).toEqual([]);
    expect(intercalaPorOrganizacao([linha("A", "a1")], 0)).toEqual([]);
    expect(intercalaPorOrganizacao([linha("A", "a1")], -1)).toEqual([]);
  });

  it("nunca devolve mais que o teto, nem repete linha", () => {
    const linhas = Array.from({ length: 40 }, (_, i) =>
      linha(`org${i % 4}`, `e${i}`),
    );

    const saida = intercalaPorOrganizacao(linhas, 10);

    expect(saida).toHaveLength(10);
    expect(new Set(saida.map((l) => l.rotulo)).size).toBe(10);
  });

  it("com 50 organizações e uma dominante, todas entram no primeiro tick", () => {
    // O cenário que esta entrega existe para resolver: 1 clínica em rajada
    // (500 eventos antigos) + 49 clínicas com 1 evento cada.
    const dominante = Array.from({ length: 500 }, (_, i) => linha("barulhenta", `x${i}`));
    const outras = Array.from({ length: 49 }, (_, i) => linha(`clinica${i}`, `c${i}`));
    const linhas = [...dominante, ...outras];

    const saida = intercalaPorOrganizacao(linhas, 50);

    const orgsServidas = new Set(saida.map((l) => l.organization_id));
    expect(orgsServidas.size).toBe(50);
    // A barulhenta leva 1 vaga por rodada, não as 50.
    expect(saida.filter((l) => l.organization_id === "barulhenta")).toHaveLength(1);
  });
});
