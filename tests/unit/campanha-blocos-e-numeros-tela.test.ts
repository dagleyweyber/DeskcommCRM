import { describe, expect, it } from "vitest";

import { blocosDoFormulario, fraseDaPrevisao } from "@/app/app/campaigns/_components/NovaCampanhaForm";
import { textoDoLimite } from "@/app/app/campaigns/_components/NumerosDaApi";

describe("formulário: espera entre blocos", () => {
  it("desligada não manda nada", () => {
    expect(blocosDoFormulario(false, "300", "30")).toBeNull();
  });

  it("⭐ ligada com números válidos vira o que a API recebe", () => {
    expect(blocosDoFormulario(true, " 300 ", "30")).toEqual({ tamanho: 300, espera_minutos: 30 });
  });

  it("fora da faixa (ou vazio) trava o botão em vez de mandar algo que a API recusa", () => {
    for (const [bloco, espera] of [["5", "30"], ["300", "0"], ["300", "2000"], ["", "30"], ["3,5", "30"]] as const) {
      expect(blocosDoFormulario(true, bloco, espera), `${bloco}/${espera}`).toBe("invalida");
    }
  });

  it("⭐ a previsão diz quantos blocos, quantas esperas e o tempo total", () => {
    expect(fraseDaPrevisao(1000, 300, 30, 1200)).toBe(
      "1.000 contatos: 4 bloco(s) com 3 esperas — cerca de 2h20 no total, contando só o horário de envio (7h às 22h).",
    );
  });
});

describe("painel de números: limite da Meta em português", () => {
  it("⭐ TIER_1K e TIER_250 viram quantidade de contatos", () => {
    expect(textoDoLimite("TIER_1K")).toBe("até 1.000 contatos diferentes a cada 24 h");
    expect(textoDoLimite("TIER_250")).toBe("até 250 contatos diferentes a cada 24 h");
    expect(textoDoLimite("TIER_UNLIMITED")).toBe("sem limite diário de contatos");
    expect(textoDoLimite(null)).toBeNull();
  });
});
