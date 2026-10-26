import { describe, expect, it } from "vitest";

import { motivoDaFalha } from "@/lib/messaging/motivo-da-falha";
import { fraseDosValoresSemFonte, valoresSemFonte } from "./valores-sem-fonte";

/**
 * Achado ao vivo (B'Laser Parnamirim): campanha criada com um modelo de 3 variáveis e o
 * mapeamento vazio. O envio recusou com `template_missing_values`, e a campanha mostrou
 * só "canal indisponível".
 */
const MODELO = {
  name: "lembrete_agendamento_laser",
  language: "pt_BR",
  components: [
    { type: "BODY", text: "Olá, {{1}}! Seu agendamento é em {{2}} às {{3}}." },
    { type: "FOOTER", text: "Clínica" },
  ],
};

describe("valoresSemFonte", () => {
  it("⭐ mapeamento VAZIO num modelo de 3 variáveis: as 3 estão sem origem", () => {
    const f = valoresSemFonte(MODELO, {});
    expect(f.map((x) => x.rotulo)).toEqual(["{{1}}", "{{2}}", "{{3}}"]);
  });

  it("origens que calculam o valor preenchem sozinhas", () => {
    const f = valoresSemFonte(MODELO, {
      "1": { kind: "contact_first_name" },
      "2": { kind: "appointment_date" },
      "3": { kind: "appointment_time" },
    });
    expect(f).toEqual([]);
  });

  it("texto fixo preenchido vale; texto fixo EM BRANCO conta como faltando", () => {
    const f = valoresSemFonte(MODELO, {
      "1": { kind: "fixed", value: "Maria" },
      "2": { kind: "fixed", value: "   " },
      "3": { kind: "fixed", value: "15:00" },
    });
    expect(f.map((x) => x.rotulo)).toEqual(["{{2}}"]);
  });

  it("modelo SEM variáveis nunca fica faltando nada", () => {
    expect(
      valoresSemFonte({ name: "oi", language: "pt_BR", components: [{ type: "BODY", text: "Olá!" }] }, {}),
    ).toEqual([]);
  });

  it("variável de botão (URL) também conta, e tem chave própria", () => {
    const f = valoresSemFonte(
      {
        name: "x",
        language: "pt_BR",
        components: [
          { type: "BODY", text: "Veja: {{1}}" },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Abrir", url: "https://x.test/{{1}}" }] },
        ],
      },
      { "1": { kind: "fixed", value: "a" } },
    );
    expect(f).toHaveLength(1); // o corpo está preenchido; o botão, não
  });

  it("a frase lista as variáveis e diz o que fazer", () => {
    const frase = fraseDosValoresSemFonte(valoresSemFonte(MODELO, {}));
    expect(frase).toContain("{{1}}, {{2}}, {{3}}");
    expect(frase).toMatch(/texto fixo ou um dado do contato/);
  });
});

describe("motivoDaFalha", () => {
  it("⭐ devolve o motivo REAL gravado pelo envio, não a frase genérica", () => {
    expect(
      motivoDaFalha({
        status: "failed",
        error_message: 'template_missing_values: "lembrete_agendamento_laser" espera 3 valor(es) — falta: 1, 2, 3',
      }),
    ).toContain("falta: 1, 2, 3");
  });

  it("sem motivo gravado, mantém a frase de antes como reserva", () => {
    expect(motivoDaFalha({ status: "queued" })).toBe(
      "mensagem ficou em 'queued' — canal indisponível no momento do envio",
    );
    expect(motivoDaFalha({ status: "failed", error_message: "   " })).toContain("canal indisponível");
  });

  it("motivo muito longo é cortado (cabe na coluna)", () => {
    expect(motivoDaFalha({ status: "failed", error_message: "x".repeat(900) })).toHaveLength(500);
  });
});
