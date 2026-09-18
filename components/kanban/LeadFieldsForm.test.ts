import { describe, expect, it } from "vitest";

import { dadosDoParceiroDe, waMeLink } from "./LeadFieldsForm";

/**
 * Achado ao vivo (RevitaFio Mossoró): o webhook de parceria já salvava
 * `parceiro`/`parceiro_codigo`/`parceiro_responsavel`/`parceiro_whatsapp` em
 * `custom_fields`, mas nada no Cartão do Lead lia isso de volta — a
 * atendente não tinha como saber que o lead veio de indicação.
 */
describe("dadosDoParceiroDe", () => {
  it("⭐ monta os 4 campos quando 'parceiro' está presente", () => {
    const r = dadosDoParceiroDe({
      parceiro: "Barbearia Acontece",
      parceiro_codigo: "NXMVDUQJ",
      parceiro_responsavel: "Dagley Weyber",
      parceiro_whatsapp: "11983389030",
    });
    expect(r).toEqual({
      parceiro: "Barbearia Acontece",
      codigo: "NXMVDUQJ",
      responsavel: "Dagley Weyber",
      whatsapp: "11983389030",
    });
  });

  it("sem 'parceiro' devolve null — lead comum não ganha bloco nenhum", () => {
    expect(dadosDoParceiroDe({})).toBeNull();
    expect(dadosDoParceiroDe(null)).toBeNull();
    expect(dadosDoParceiroDe({ produto_interesse: "Corte" })).toBeNull();
  });

  it("campos extras ausentes viram null individualmente, sem quebrar o bloco inteiro", () => {
    const r = dadosDoParceiroDe({ parceiro: "Studio X" });
    expect(r).toEqual({ parceiro: "Studio X", codigo: null, responsavel: null, whatsapp: null });
  });
});

describe("waMeLink", () => {
  it("mantém só dígitos, do jeito que o wa.me exige", () => {
    expect(waMeLink("+55 (11) 98338-9030")).toBe("https://wa.me/5511983389030");
  });
});
