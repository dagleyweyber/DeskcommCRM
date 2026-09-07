import { describe, expect, it } from "vitest";

import { resolveValuesForRecipient } from "./resolve-values";

describe("resolveValuesForRecipient", () => {
  it("texto fixo sai igual pra todo mundo", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "fixed", value: "Promoção de setembro" } },
      { displayName: "María González" },
    );
    expect(r).toEqual({ "1": "Promoção de setembro" });
  });

  it("nome do contato usa o rótulo inteiro", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_name" } },
      { displayName: "María González" },
    );
    expect(r["1"]).toBe("María González");
  });

  it("primeiro nome corta no primeiro espaço", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_first_name" } },
      { displayName: "María González" },
    );
    expect(r["1"]).toBe("María");
  });

  it("nome de uma palavra só não quebra o primeiro nome", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_first_name" } },
      { displayName: "María" },
    );
    expect(r["1"]).toBe("María");
  });

  it("vários slots resolvem independentes, cada um com sua fonte", () => {
    const r = resolveValuesForRecipient(
      {
        "1": { kind: "contact_first_name" },
        "header:1": { kind: "fixed", value: "Bem-vindo" },
        "button0:1": { kind: "contact_name" },
      },
      { displayName: "Ana Paula Silva" },
    );
    expect(r).toEqual({
      "1": "Ana",
      "header:1": "Bem-vindo",
      "button0:1": "Ana Paula Silva",
    });
  });

  it("mapeamento vazio devolve objeto vazio, não erro", () => {
    expect(resolveValuesForRecipient({}, { displayName: "Qualquer" })).toEqual({});
  });
});
