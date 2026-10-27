import { describe, expect, it } from "vitest";

import { botoesDeRespostaRapida, classificaResposta, normalizaTextoDeBotao } from "./confirmacao";

const AUTOMACAO = { confirm_button_text: "Confirmo presença", decline_button_text: "Preciso remarcar" };

describe("confirmação automática — classificar a resposta do botão", () => {
  it("⭐ botão de confirmar → confirmed; botão de desmarcar → declined", () => {
    expect(classificaResposta({ texto: "Confirmo presença", payload: null }, AUTOMACAO)).toBe("confirmed");
    expect(classificaResposta({ texto: "Preciso remarcar", payload: null }, AUTOMACAO)).toBe("declined");
  });

  it("ignora caixa, acento e espaço sobrando", () => {
    expect(classificaResposta({ texto: "  CONFIRMO   presenca ", payload: null }, AUTOMACAO)).toBe("confirmed");
  });

  it("usa o payload quando o texto não vem", () => {
    expect(classificaResposta({ texto: null, payload: "Preciso remarcar" }, AUTOMACAO)).toBe("declined");
  });

  it("⭐ texto livre ou botão sem significado configurado não mexe em nada", () => {
    expect(classificaResposta({ texto: "sim, mas preciso remarcar", payload: null }, AUTOMACAO)).toBeNull();
    expect(classificaResposta({ texto: "Ver endereço", payload: null }, AUTOMACAO)).toBeNull();
    expect(
      classificaResposta({ texto: "Confirmo presença", payload: null }, { confirm_button_text: null, decline_button_text: null }),
    ).toBeNull();
  });

  it("lê os botões de resposta rápida do modelo, ignorando link e telefone", () => {
    const components = [
      { type: "BODY", text: "Olá {{1}}" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Confirmo presença" },
          { type: "URL", text: "Ver endereço", url: "https://x" },
          { type: "QUICK_REPLY", text: "Preciso remarcar" },
        ],
      },
    ];
    expect(botoesDeRespostaRapida(components)).toEqual(["Confirmo presença", "Preciso remarcar"]);
    expect(botoesDeRespostaRapida(null)).toEqual([]);
  });

  it("normaliza vazio para string vazia", () => {
    expect(normalizaTextoDeBotao(null)).toBe("");
  });
});
