import { describe, expect, it } from "vitest";

import { nomesParaPreencher, type ContatoParaNome } from "@/lib/agenda-externa/nomes";

const contato = (p: Partial<ContatoParaNome> = {}): ContatoParaNome => ({
  display_name: null,
  name: null,
  phone_number: "+558199840510",
  is_anonymized: false,
  ...p,
});

describe("nome do Belle → contato sem nome", () => {
  it("⭐ contato sem nome ganha o nome do Belle (display_name e name)", () => {
    const r = nomesParaPreencher(new Map([["c1", contato()]]), [["c1", "Maria da Silva"]]);
    expect(r).toEqual([{ id: "c1", display_name: "Maria da Silva", name: "Maria da Silva" }]);
  });

  it("⭐ nome que alguém já tem NUNCA é sobrescrito", () => {
    const r = nomesParaPreencher(new Map([["c1", contato({ display_name: "Maria (Instagram)" })]]), [["c1", "Maria da Silva"]]);
    expect(r).toEqual([]);
  });

  it("contato anonimizado (LGPD) não volta a ter nome", () => {
    const r = nomesParaPreencher(new Map([["c1", contato({ is_anonymized: true })]]), [["c1", "Maria"]]);
    expect(r).toEqual([]);
  });

  it("name que já tem valor real é preservado; só o display_name é preenchido", () => {
    const r = nomesParaPreencher(new Map([["c1", contato({ name: "Mari" })]]), [["c1", "Maria da Silva"]]);
    expect(r).toEqual([{ id: "c1", display_name: "Maria da Silva" }]);
  });

  it("name igual ao telefone (o que o CRM grava sem nome) é refeito", () => {
    const r = nomesParaPreencher(new Map([["c1", contato({ name: "+558199840510" })]]), [["c1", "Maria"]]);
    expect(r).toEqual([{ id: "c1", display_name: "Maria", name: "Maria" }]);
  });

  it("nome vazio ou só espaços vindo do Belle não preenche nada", () => {
    expect(nomesParaPreencher(new Map([["c1", contato()]]), [["c1", "   "]])).toEqual([]);
  });

  it("contato que não existia antes (criado agora, já com nome) não entra", () => {
    expect(nomesParaPreencher(new Map(), [["novo", "Maria"]])).toEqual([]);
  });

  it("vários agendamentos do mesmo contato geram uma atualização só", () => {
    const r = nomesParaPreencher(new Map([["c1", contato()]]), [["c1", "Maria"], ["c1", "Maria S."]]);
    expect(r).toHaveLength(1);
    expect(r[0]?.display_name).toBe("Maria");
  });
});
