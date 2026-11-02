import { describe, expect, it } from "vitest";

import {
  canonizarTag,
  detectarColunas,
  emLotes,
  prepararLinhas,
  separarTags,
  telefoneDaPlanilha,
} from "@/lib/contacts/importacao";

describe("detectarColunas — o cabeçalho que as clínicas exportam", () => {
  it("⭐ reconhece nomes comuns, com acento e caixa variados", () => {
    expect(detectarColunas(["Nome do Cliente", "Celular/WhatsApp", "E-mail", "Etiquetas"])).toEqual({
      nome: 0,
      telefone: 1,
      email: 2,
      tags: 3,
    });
  });

  it("coluna não reconhecida fica sem mapeamento (o operador escolhe na tela)", () => {
    expect(detectarColunas(["Código", "Telefone"])).toEqual({ nome: null, telefone: 1, email: null, tags: null });
  });

  it("uma coluna nunca serve dois campos", () => {
    const m = detectarColunas(["Telefone", "Contato"]);
    expect(m.telefone).toBe(0);
    expect(m.nome).toBeNull();
  });
});

describe("telefoneDaPlanilha", () => {
  it.each([
    ["(81) 99184-0070", "+5581991840070"],
    ["81991840070", "+5581991840070"],
    ["081 99184-0070", "+5581991840070"],
    ["55 81 99184-0070", "+5581991840070"],
    ["+55 (81) 9184-0070", "+558191840070"],
    [5581991840070, "+5581991840070"],
  ])("%s → %s", (bruto, esperado) => {
    expect(telefoneDaPlanilha(bruto)).toEqual({ e164: esperado });
  });

  it("⭐ notação científica do Excel é recusada com motivo próprio — os dígitos já se perderam", () => {
    expect(telefoneDaPlanilha("5,58199E+12")).toEqual({ motivo: "telefone_cientifico" });
    expect(telefoneDaPlanilha("5.58199e12")).toEqual({ motivo: "telefone_cientifico" });
  });

  it("vazio e curto demais têm motivos distintos", () => {
    expect(telefoneDaPlanilha("  ")).toEqual({ motivo: "sem_telefone" });
    expect(telefoneDaPlanilha("9184-0070")).toEqual({ motivo: "telefone_invalido" });
  });
});

describe("tags", () => {
  it("célula com vários separadores", () => {
    expect(separarTags(" vip, laser ;2024 | ")).toEqual(["vip", "laser", "2024"]);
  });

  it("⭐ reaproveita a grafia que já existe — campanha filtra por igualdade exata", () => {
    expect(canonizarTag("VIP", ["vip", "Pós venda"])).toBe("vip");
    expect(canonizarTag("pos  venda", ["vip", "Pós venda"])).toBe("Pós venda");
    expect(canonizarTag("nova", ["vip"])).toBe("nova");
  });
});

describe("prepararLinhas", () => {
  const m = { nome: 0, telefone: 1, email: 2, tags: 3 };

  it("⭐ mesma pessoa com e sem o 9º dígito é UMA linha; as tags somam na primeira", () => {
    const r = prepararLinhas(
      [
        ["Vivianne", "81 99184-0070", "", "laser"],
        ["Vivianne L.", "+55 81 9184-0070", "", "vip"],
      ],
      m,
    );
    expect(r.prontas).toHaveLength(1);
    expect(r.prontas[0]).toMatchObject({ linha: 2, telefone: "+5581991840070", nome: "Vivianne", tags: ["laser", "vip"] });
    expect(r.problemas).toEqual([
      { linha: 3, motivo: "duplicado_no_arquivo", telefoneBruto: "+55 81 9184-0070", nome: "Vivianne L." },
    ]);
  });

  it("número da linha é o da planilha (cabeçalho = 1), para o operador achar", () => {
    const r = prepararLinhas([["Ana", "81991840070"], ["Bia", "123"]], { nome: 0, telefone: 1, email: null, tags: null });
    expect(r.prontas[0]?.linha).toBe(2);
    expect(r.problemas[0]).toMatchObject({ linha: 3, motivo: "telefone_invalido" });
  });

  it("linha totalmente vazia (fim de planilha) é ignorada sem virar problema", () => {
    const r = prepararLinhas([["", "", "", ""], ["Ana", "81991840070", "", ""]], m);
    expect(r.problemas).toEqual([]);
    expect(r.prontas).toHaveLength(1);
  });

  it("e-mail inválido não derruba a linha — o contato entra sem ele", () => {
    const r = prepararLinhas([["Ana", "81991840070", "ana@", ""]], m);
    expect(r.prontas[0]?.email).toBeNull();
  });

  it("e-mail vai em minúsculas", () => {
    const r = prepararLinhas([["Ana", "81991840070", "Ana@Clinica.com", ""]], m);
    expect(r.prontas[0]?.email).toBe("ana@clinica.com");
  });
});

describe("emLotes", () => {
  it("divide mantendo a ordem", () => {
    expect(emLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
