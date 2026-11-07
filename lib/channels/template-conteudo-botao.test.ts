import { describe, expect, it } from "vitest";

import { montarComponents, textoDeBotaoAceitoPelaMeta } from "./template-conteudo";

describe("textoDeBotaoAceitoPelaMeta", () => {
  it("tira emoji, formatação, quebra de linha e variável — o que a Meta recusa em botão", () => {
    expect(textoDeBotaoAceitoPelaMeta("🔗 Acessar grupo VIP")).toBe("Acessar grupo VIP");
    expect(textoDeBotaoAceitoPelaMeta("👍🏽 Quero *já*")).toBe("Quero já");
    expect(textoDeBotaoAceitoPelaMeta("Oi {{1}}\nvem")).toBe("Oi vem");
  });

  it("não mexe em texto que já é válido (acentos incluídos)", () => {
    expect(textoDeBotaoAceitoPelaMeta("Confirmo presença")).toBe("Confirmo presença");
  });
});

describe("montarComponents — botões", () => {
  it("o botão sai sem emoji e um botão que ficou vazio é descartado", () => {
    const c = montarComponents({
      body: "Oi",
      exemplos: [],
      botoes: [
        { tipo: "url", texto: "🔗 Acessar grupo VIP", url: "https://chat.whatsapp.com/x" },
        { tipo: "quick_reply", texto: "🎉" },
      ],
    }) as Array<{ type: string; buttons?: Array<{ text: string }> }>;
    const botoes = c.find((x) => x.type === "BUTTONS")!.buttons!;
    expect(botoes).toHaveLength(1);
    expect(botoes[0]!.text).toBe("Acessar grupo VIP");
  });
});
