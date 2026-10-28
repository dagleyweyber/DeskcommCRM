import { describe, expect, it } from "vitest";

import { motivoDaEntrega, motivoDaFalha, motivoParaTela } from "./motivo-da-falha";

const PAGAMENTO = {
  failure_code: 131042,
  failure_reason:
    "Business eligibility payment issue — Message failed to send because your WhatsApp Business account payment method is invalid.",
};

describe("motivo da falha de uma mensagem", () => {
  it("⭐ falha de entrega por pagamento (131042) vira instrução em português, não 'Erro desconhecido'", () => {
    const texto = motivoParaTela({ error_message: null, metadata: PAGAMENTO });
    expect(texto).toMatch(/forma de pagamento/i);
    expect(texto).toMatch(/Cobrança/);
    expect(texto).not.toMatch(/desconhecido/i);
  });

  it("⭐ error_message (recusa síncrona) tem prioridade sobre o motivo de entrega", () => {
    expect(motivoParaTela({ error_message: "template_missing_values: falta 1, 2, 3", metadata: PAGAMENTO })).toBe(
      "template_missing_values: falta 1, 2, 3",
    );
  });

  it("código desconhecido mostra o texto original da Meta, com o código", () => {
    expect(motivoDaEntrega({ failure_code: 999999, failure_reason: "Algo novo da Meta" })).toBe(
      "Algo novo da Meta (código 999999)",
    );
  });

  it("aceita o código como texto e sem motivo bruto", () => {
    expect(motivoDaEntrega({ failure_code: "131047" })).toMatch(/janela de 24h/);
  });

  it("sem nenhum motivo gravado, a bolha continua dizendo 'Erro desconhecido'", () => {
    expect(motivoParaTela({ error_message: null, metadata: {} })).toBe("Erro desconhecido");
    expect(motivoParaTela({ error_message: null, error_code: "E42", metadata: null })).toBe("E42");
  });

  it("⭐ relatório de campanha/automação também enxerga a falha de entrega", () => {
    expect(motivoDaFalha({ status: "failed", error_message: null, metadata: PAGAMENTO })).toMatch(/pagamento/i);
  });

  it("a frase antiga continua como reserva quando não há motivo algum", () => {
    expect(motivoDaFalha({ status: "queued", error_message: null })).toBe(
      "mensagem ficou em 'queued' — canal indisponível no momento do envio",
    );
  });
});
