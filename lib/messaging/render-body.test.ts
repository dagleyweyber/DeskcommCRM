import { describe, expect, it } from "vitest";

import { renderBodyWithValues } from "./render-body";

describe("renderBodyWithValues", () => {
  it("troca cada {{n}} pelo valor resolvido", () => {
    expect(renderBodyWithValues("Olá {{1}}, seu pedido {{2}} chegou.", { "1": "Ana", "2": "#42" })).toBe(
      "Olá Ana, seu pedido #42 chegou.",
    );
  });

  it("chave sem valor resolvido mantém o placeholder — nunca some silenciosamente", () => {
    expect(renderBodyWithValues("Olá {{1}}", {})).toBe("Olá {{1}}");
  });

  it("texto sem placeholder passa direto", () => {
    expect(renderBodyWithValues("Texto fixo", { "1": "Ana" })).toBe("Texto fixo");
  });

  it("não confunde chave de botão/cabeçalho — só substitui o que está no próprio texto", () => {
    // `header:1`/`button0:1` não têm `{{header:1}}` no corpo — não há como
    // colidir, mas o teste prova que valores extras no mapa não vazam.
    expect(
      renderBodyWithValues("Olá {{1}}", { "1": "Ana", "header:1": "Bem-vindo", "button0:1": "x" }),
    ).toBe("Olá Ana");
  });
});
