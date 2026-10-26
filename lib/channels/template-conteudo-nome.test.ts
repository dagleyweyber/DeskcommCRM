import { describe, expect, it } from "vitest";

import { LIMITE_NOME_DO_MODELO, normalizarNomeDoModelo, semSublinhadoNoFim } from "./template-conteudo";

/**
 * Achado ao vivo (RevitaFio Mossoró): o operador preencheu o modelo inteiro e a plataforma
 * recusou no fim — "o nome do modelo só pode ter letras minúsculas e sublinhados". O nome
 * agora é normalizado enquanto se digita.
 */
describe("normalizarNomeDoModelo", () => {
  it.each([
    ["Confirmação de Agendamento", "confirmacao_de_agendamento"],
    ["agendamento_confirmado", "agendamento_confirmado"], // já válido: não muda
    ["Lembrete 24h", "lembrete_24h"],
    ["pós-consulta", "pos_consulta"],
    ["  Olá, tudo bem?  ", "ola_tudo_bem_"], // sem sublinhado no começo; o do fim fica (digitando)
    ["promoção  de  VERÃO!!", "promocao_de_verao"],
    ["a - b", "a_b"], // " - " vira UM sublinhado
    ["ação_ç", "acao_c"],
  ])("%j → %j", (entrada, esperado) => {
    expect(normalizarNomeDoModelo(entrada)).toBe(esperado);
  });

  it("⭐ o resultado SEMPRE obedece à regra da plataforma (minúsculas, números, sublinhado)", () => {
    const sujeiras = ["Ünï Cödé", "A/B\\C", "x\ty\nz", "🔥 oferta 🔥", "ÀÉÎÕÜ ÇÑ", "a.b,c;d:e", "CAPS_LOCK_123", "tab\tulação"];
    for (const s of sujeiras) {
      expect(normalizarNomeDoModelo(s)).toMatch(/^[a-z0-9_]*$/);
    }
  });

  it("é idempotente: normalizar duas vezes dá o mesmo (o campo roda a cada tecla)", () => {
    for (const s of ["Confirmação de Agendamento", "a - b", "X__Y", "ok_123"]) {
      const uma = normalizarNomeDoModelo(s);
      expect(normalizarNomeDoModelo(uma)).toBe(uma);
    }
  });

  it("vazio continua vazio, e só símbolos viram vazio (o botão de enviar segue desligado)", () => {
    expect(normalizarNomeDoModelo("")).toBe("");
    expect(normalizarNomeDoModelo("!!!???")).toBe("");
  });

  it("⭐ dá para DIGITAR um nome com duas palavras: o espaço no fim vira sublinhado e fica", () => {
    expect(normalizarNomeDoModelo("confirmacao ")).toBe("confirmacao_");
    expect(normalizarNomeDoModelo("confirmacao de")).toBe("confirmacao_de");
  });

  it("ao ENVIAR, o sublinhado que sobrou no fim sai", () => {
    expect(semSublinhadoNoFim("confirmacao_de_")).toBe("confirmacao_de");
    expect(semSublinhadoNoFim("a__")).toBe("a");
    expect(semSublinhadoNoFim("ok")).toBe("ok");
  });

  it("o limite documentado da plataforma é exposto (a tela corta nele)", () => {
    expect(LIMITE_NOME_DO_MODELO).toBe(512);
  });
});
