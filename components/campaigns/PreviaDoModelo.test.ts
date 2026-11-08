import { describe, expect, it } from "vitest";

import { trechosDaPrevia, valorDeExemplo } from "./PreviaDoModelo";

describe("prévia do modelo na campanha", () => {
  it("troca cada {{n}} pelo valor escolhido e destaca o que falta", () => {
    const trechos = trechosDaPrevia(
      "Olá, {{1}}! Seu horário é {{2}}.",
      { kind: "body" },
      { "1": { kind: "contact_first_name" } },
    );
    expect(trechos).toEqual([
      { texto: "Olá, " },
      { texto: "Maria", variavel: true },
      { texto: "! Seu horário é " },
      { texto: "{{2}}", faltando: true },
      { texto: "." },
    ]);
  });

  it("cabeçalho usa a chave própria, não a do corpo", () => {
    const trechos = trechosDaPrevia("Oi {{1}}", { kind: "header" }, {
      "1": { kind: "fixed", value: "corpo" },
      "header:1": { kind: "fixed", value: "cabeçalho" },
    });
    expect(trechos.map((t) => t.texto).join("")).toBe("Oi cabeçalho");
  });

  it("texto fixo em branco conta como faltando", () => {
    expect(valorDeExemplo({ kind: "fixed", value: "  " })).toBeNull();
    expect(valorDeExemplo(undefined)).toBeNull();
  });
});
