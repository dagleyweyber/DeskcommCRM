import { describe, expect, it } from "vitest";

import {
  GRUPO,
  LIMITE_DO_VALOR,
  comValor,
  lerTag,
  limpaValor,
  mesclaTagsLivres,
  montaTag,
  rotuloDaTag,
  rotuloDoValor,
  secoesDeFiltro,
  semGrupo,
  separaTags,
  valoresDoGrupo,
} from "./estruturadas";

describe("limpaValor", () => {
  it("⭐ tira a vírgula: o formulário do lead separa tags por vírgula e partiria o nome em duas", () => {
    expect(limpaValor("Botox, Curitiba  — Out/26")).toBe("Botox Curitiba — Out/26");
  });

  it("corta no limite e não deixa espaço pendurado no fim", () => {
    const v = limpaValor(`${"a".repeat(LIMITE_DO_VALOR - 1)} bbbbbb`);
    expect(v.length).toBeLessThanOrEqual(LIMITE_DO_VALOR);
    expect(v.endsWith(" ")).toBe(false);
  });

  it("vazio e nulo viram vazio", () => {
    expect(limpaValor(null)).toBe("");
    expect(limpaValor("   ")).toBe("");
  });
});

describe("montaTag / lerTag", () => {
  it("monta e lê de volta, mesmo com ':' no valor (separa só no primeiro)", () => {
    expect(montaTag(GRUPO.CAMPANHA, "Promo: Botox")).toBe("campanha:Promo: Botox");
    expect(lerTag("campanha:Promo: Botox")).toEqual({ grupo: "campanha", valor: "Promo: Botox" });
  });

  it("⭐ grupo FECHADO só aceita o vocabulário: temperatura 'gelado' não vira tag", () => {
    expect(montaTag(GRUPO.TEMPERATURA, "gelado")).toBeNull();
    expect(montaTag(GRUPO.TEMPERATURA, "quente")).toBe("temperatura:quente");
  });

  it("⭐ tag comum e grupo desconhecido continuam sendo tag comum", () => {
    expect(lerTag("vip")).toBeNull();
    expect(lerTag("plano:gold")).toBeNull();
    expect(lerTag("campanha:")).toBeNull();
    expect(lerTag(":x")).toBeNull();
  });
});

describe("comValor", () => {
  it("⭐ grupo exclusivo TROCA: pôr 'frio' tira 'quente' e preserva as outras tags", () => {
    expect(comValor(["vip", "temperatura:quente", "origem:meta-ads"], GRUPO.TEMPERATURA, "frio")).toEqual([
      "vip",
      "origem:meta-ads",
      "temperatura:frio",
    ]);
  });

  it("é idempotente: repetir o mesmo valor não mexe nas tags", () => {
    const antes = ["vip", "temperatura:morno"];
    expect(comValor(antes, GRUPO.TEMPERATURA, "morno")).toEqual(antes);
  });

  it("⭐ limpa lead que já tinha dois valores de grupo exclusivo (dado sujo)", () => {
    expect(comValor(["temperatura:quente", "temperatura:frio"], GRUPO.TEMPERATURA, "frio")).toEqual(["temperatura:frio"]);
  });

  it("grupo múltiplo ACRESCENTA: Instagram não tira Meta Ads", () => {
    const t = comValor(comValor([], GRUPO.ORIGEM, "meta-ads"), GRUPO.ORIGEM, "instagram");
    expect(t).toEqual(["origem:meta-ads", "origem:instagram"]);
  });

  it("valor que o grupo não aceita devolve as tags como estavam", () => {
    expect(comValor(["vip"], GRUPO.TEMPERATURA, "gelado")).toEqual(["vip"]);
  });

  it("não altera o array recebido", () => {
    const antes = Object.freeze(["temperatura:quente"]);
    expect(() => comValor(antes, GRUPO.TEMPERATURA, "frio")).not.toThrow();
  });
});

describe("semGrupo / valoresDoGrupo / separaTags", () => {
  const tags = ["vip", "temperatura:quente", "origem:meta-ads", "origem:instagram", "campanha:Botox", "plano:gold"];

  it("semGrupo tira o grupo inteiro e só ele", () => {
    expect(semGrupo(tags, GRUPO.ORIGEM)).toEqual(["vip", "temperatura:quente", "campanha:Botox", "plano:gold"]);
  });

  it("valoresDoGrupo devolve os valores, sem o prefixo", () => {
    expect(valoresDoGrupo(tags, GRUPO.ORIGEM)).toEqual(["meta-ads", "instagram"]);
  });

  it("⭐ separaTags: 'plano:gold' (grupo que não existe aqui) fica entre as livres", () => {
    const s = separaTags(tags);
    expect(s.livres).toEqual(["vip", "plano:gold"]);
    expect(s.porGrupo.temperatura).toEqual(["quente"]);
    expect(s.porGrupo.anuncio).toEqual([]);
  });
});

describe("mesclaTagsLivres", () => {
  const lead = ["vip", "recompra", "temperatura:quente", "origem:meta-ads", "campanha:Botox"];

  it("⭐ salvar o formulário NÃO apaga a origem, a campanha nem a temperatura do lead", () => {
    expect(mesclaTagsLivres(lead, ["vip", "recompra"])).toEqual(["temperatura:quente", "origem:meta-ads", "campanha:Botox", "vip", "recompra"]);
  });

  it("as livres digitadas substituem as livres antigas (dá para remover uma)", () => {
    expect(mesclaTagsLivres(lead, ["vip"])).toEqual(["temperatura:quente", "origem:meta-ads", "campanha:Botox", "vip"]);
  });

  it("⭐ digitar 'temperatura:frio' troca a temperatura, não duplica", () => {
    const r = mesclaTagsLivres(lead, ["temperatura:frio"]);
    expect(r).toContain("temperatura:frio");
    expect(r).not.toContain("temperatura:quente");
  });

  it("⭐ valor que o grupo não aceita ('temperatura:gelado') fica como tag comum, não some", () => {
    expect(mesclaTagsLivres([], ["temperatura:gelado"])).toEqual(["temperatura:gelado"]);
  });

  it("grupo desconhecido ('plano:gold') é tag comum", () => {
    expect(mesclaTagsLivres(["plano:gold"], ["plano:gold"])).toEqual(["plano:gold"]);
  });

  it("não duplica tag livre repetida", () => {
    expect(mesclaTagsLivres([], ["vip", "vip"])).toEqual(["vip"]);
  });
});

describe("secoesDeFiltro / rotuloDaTag", () => {
  it("⭐ arruma por grupo na ordem do catálogo, livres por último, sem seção vazia", () => {
    const s = secoesDeFiltro(["vip", "origem:instagram", "temperatura:frio", "origem:meta-ads", "temperatura:quente", "plano:gold"]);
    expect(s.map((x) => x.rotulo)).toEqual(["Temperatura", "Origem", "Outras tags"]);
    expect(s[0]!.itens.map((i) => i.rotulo)).toEqual(["Frio", "Quente"]);
    expect(s[1]!.itens.map((i) => i.rotulo)).toEqual(["Instagram", "Meta Ads"]);
    expect(s[2]!.itens.map((i) => i.tag)).toEqual(["plano:gold", "vip"]);
  });

  it("a tag guardada continua sendo a tag inteira (é ela que o filtro compara)", () => {
    expect(secoesDeFiltro(["temperatura:quente"])[0]!.itens[0]).toEqual({ tag: "temperatura:quente", rotulo: "Quente" });
  });

  it("sem tags, sem seções; repetidas contam uma vez", () => {
    expect(secoesDeFiltro([])).toEqual([]);
    expect(secoesDeFiltro(["vip", "vip"])[0]!.itens).toHaveLength(1);
  });

  it("rotuloDaTag: grupo mostra 'Grupo: Valor'; tag livre, ela mesma", () => {
    expect(rotuloDaTag("origem:google-ads")).toBe("Origem: Google Ads");
    expect(rotuloDaTag("campanha:Botox Out/26")).toBe("Campanha: Botox Out/26");
    expect(rotuloDaTag("vip")).toBe("vip");
  });
});

describe("rotuloDoValor", () => {
  it("vocabulário fechado mostra o rótulo; aberto mostra o próprio texto", () => {
    expect(rotuloDoValor(GRUPO.ORIGEM, "google-ads")).toBe("Google Ads");
    expect(rotuloDoValor(GRUPO.CAMPANHA, "Botox Out/26")).toBe("Botox Out/26");
  });
});
