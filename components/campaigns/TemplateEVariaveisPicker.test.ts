import { describe, expect, it } from "vitest";

import { fontesPara, placeholderPara } from "./TemplateEVariaveisPicker";

/**
 * Achado ao vivo (RevitaFio Mossoró): campanha com template de cabeçalho de
 * imagem mandava "Primeiro nome" pro campo que a Meta espera como
 * `image.link` — a tela oferecia "Nome do contato"/"Primeiro nome" pra
 * QUALQUER slot, sem diferenciar texto de mídia. Nome de contato nunca é
 * uma URL válida; a Meta recusou TODO envio da campanha com
 * `(#100) Param ... image.link is not a valid URI`.
 */
describe("fontesPara — slot de mídia só aceita texto fixo", () => {
  it("⭐ slot 'image' não oferece contact_name nem contact_first_name — só fixed", () => {
    const fontes = fontesPara("image", []);
    expect(fontes.map((f) => f.kind)).toEqual(["fixed"]);
  });

  it("slot 'video' e 'document' também restringem a fixed", () => {
    expect(fontesPara("video", []).map((f) => f.kind)).toEqual(["fixed"]);
    expect(fontesPara("document", []).map((f) => f.kind)).toEqual(["fixed"]);
  });

  it("slot 'coupon_code' restringe a fixed — código de cupom não é atributo de contato", () => {
    expect(fontesPara("coupon_code", []).map((f) => f.kind)).toEqual(["fixed"]);
  });

  it("slot 'text' (o caso comum) mantém todas as fontes, incluindo extras do gatilho", () => {
    const extras = [{ kind: "appointment_date" as const, label: "Data do agendamento" }];
    const fontes = fontesPara("text", extras);
    expect(fontes.map((f) => f.kind)).toEqual([
      "fixed",
      "contact_name",
      "contact_first_name",
      "appointment_date",
    ]);
  });

  it("slot 'url_suffix' (sufixo de botão de link) também mantém todas as fontes", () => {
    expect(fontesPara("url_suffix", []).map((f) => f.kind)).toEqual([
      "fixed",
      "contact_name",
      "contact_first_name",
    ]);
  });
});

describe("placeholderPara — dica do campo de texto fixo por tipo", () => {
  it("image/video/document pedem URL, não 'valor pra todo mundo'", () => {
    expect(placeholderPara("image")).toMatch(/^https:\/\//);
    expect(placeholderPara("video")).toMatch(/^https:\/\//);
    expect(placeholderPara("document")).toMatch(/^https:\/\//);
  });

  it("coupon_code pede código, não URL", () => {
    expect(placeholderPara("coupon_code")).not.toMatch(/https:\/\//);
  });

  it("text cai no genérico de sempre", () => {
    expect(placeholderPara("text")).toBe("Valor pra todo mundo");
  });
});
