import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lerRetratoDoModelo, retratoDoModelo } from "@/lib/messaging/retrato-do-modelo";

/** O modelo real da confirmação de B'Laser Parnamirim (lembrete_agendamento_laser), corpo encurtado. */
const CONFIRMACAO = [
  { type: "BODY", text: "Olá, {{1}}! Confirme sua sessão do dia {{2}} às {{3}}." },
  { type: "FOOTER", text: "B'Laser Parnamirim" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirmar" },
      { type: "QUICK_REPLY", text: "Preciso reagendar" },
    ],
  },
];

describe("retrato do modelo — o que o cliente viu além do corpo", () => {
  it("⭐ confirmação de agendamento: rodapé e os dois botões, na ordem do modelo", () => {
    expect(retratoDoModelo(CONFIRMACAO, { "1": "Ana" })).toEqual({
      header: null,
      footer: "B'Laser Parnamirim",
      buttons: [
        { type: "QUICK_REPLY", text: "Confirmar" },
        { type: "QUICK_REPLY", text: "Preciso reagendar" },
      ],
    });
  });

  it("cabeçalho de texto com variável sai preenchido com o valor `header:` enviado", () => {
    const r = retratoDoModelo([{ type: "HEADER", format: "TEXT", text: "Oi {{1}}" }], { "header:1": "Ana", "1": "x" });
    expect(r?.header).toBe("Oi Ana");
  });

  it("cabeçalho de mídia NÃO vira texto — a mídia já tem caminho próprio na mensagem", () => {
    expect(retratoDoModelo([{ type: "HEADER", format: "IMAGE" }])).toBeNull();
  });

  it("botão de link guarda a URL com a parte variável do PRÓPRIO botão (button<i>:)", () => {
    const r = retratoDoModelo(
      [
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Não reconheço" },
            { type: "URL", text: "Clique aqui", url: "https://chat.whatsapp.com/{{1}}" },
            { type: "PHONE_NUMBER", text: "Ligar", phone_number: "+5581999999999" },
          ],
        },
      ],
      { "button1:1": "AbC123", "1": "nao-e-este" },
    );
    expect(r?.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Não reconheço" },
      { type: "URL", text: "Clique aqui", url: "https://chat.whatsapp.com/AbC123" },
      { type: "PHONE_NUMBER", text: "Ligar", phone: "+5581999999999" },
    ]);
  });

  it("aceita a caixa baixa do intermediário (`buttons`, `quick_reply`)", () => {
    const r = retratoDoModelo([{ type: "buttons", buttons: [{ type: "quick_reply", text: "Sim" }] }]);
    expect(r?.buttons).toEqual([{ type: "QUICK_REPLY", text: "Sim" }]);
  });

  it("modelo só com corpo não ganha retrato — a bolha fica exatamente como era", () => {
    expect(retratoDoModelo([{ type: "BODY", text: "Olá" }])).toBeNull();
  });

  it("definição ausente (não espelhada) não quebra: sem retrato", () => {
    expect(retratoDoModelo(undefined)).toBeNull();
    expect(retratoDoModelo(null)).toBeNull();
  });
});

describe("leitura do retrato gravado na mensagem", () => {
  it("ida e volta: o que o envio grava é o que a bolha lê", () => {
    const gravado = retratoDoModelo(CONFIRMACAO);
    expect(lerRetratoDoModelo({ ai_actor_id: "x", template: gravado })).toEqual(gravado);
  });

  it("metadata sem retrato (mensagem antiga, texto comum) → null", () => {
    expect(lerRetratoDoModelo({})).toBeNull();
    expect(lerRetratoDoModelo(null)).toBeNull();
  });

  it("jsonb malformado não derruba a conversa: descarta o que não é botão", () => {
    expect(
      lerRetratoDoModelo({ template: { buttons: [null, 3, { text: "" }, { type: "QUICK_REPLY", text: "Ok" }] } }),
    ).toEqual({ header: null, footer: null, buttons: [{ type: "QUICK_REPLY", text: "Ok" }] });
    expect(lerRetratoDoModelo({ template: "lixo" })).toBeNull();
  });
});

describe("a gravação está no caminho único de envio", () => {
  const HANDLER = readFileSync("app/api/v1/messages/_handler.ts", "utf8");

  it("o retrato sai da MESMA leitura que o pré-voo aprovou (sem segunda consulta à definição)", () => {
    expect(HANDLER).toMatch(/const definicao = await conferirDefinicao\(/);
    expect(HANDLER).toMatch(/retrato = retratoDoModelo\(definicao, input\.template_values/);
  });

  it("é gravado junto com o `sent`, preservando o metadata que já existia", () => {
    expect(HANDLER).toMatch(/metadata: \{ \.\.\.\(message\.metadata \?\? \{\}\), template: retrato \}/);
  });
});
