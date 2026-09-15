import { readFileSync } from "node:fs";

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

/**
 * O pedido depois do fix acima: "não tem uma forma melhor, minhas imagens
 * não estão hospedadas em lugar nenhum" — o CRM já tem upload funcionando
 * (o composer do inbox manda imagem pelo canal oficial reaproveitando a
 * MESMA rota de Storage), só faltava o botão aqui. Envio de mensagem aceita
 * link direto (`lib/channels/adapters/meta-cloud.ts`'s `mediaPayload`); só
 * CRIAÇÃO de definição exige o handle da Resumable Upload API — rotas
 * diferentes de propósito, não confundir uma pela outra de novo.
 */
describe("upload de imagem pro slot de mídia (fonte-grep — sem harness de file input em RTL)", () => {
  const fonte = readFileSync("components/campaigns/TemplateEVariaveisPicker.tsx", "utf8");

  it("usa a rota de Storage (URL assinada), não a de criação de template (handle)", () => {
    expect(fonte).toMatch(/\/api\/v1\/channels\/partner\/templates\/media/);
    expect(
      fonte,
      "rota errada aqui geraria handle, não URL — 'não é uma URI válida' de novo no envio",
    ).not.toMatch(/\/api\/v1\/channels\/templates\/media["'`]/);
  });

  it("botão de upload só aparece pra slot 'image' — vídeo/documento continuam por URL colada", () => {
    const bloco = fonte.slice(fonte.indexOf("subirImagem(key, f)") - 1000, fonte.indexOf("subirImagem(key, f)"));
    expect(bloco).toMatch(/s\.expects === "image"/);
  });

  it("sucesso do upload grava a URL devolvida como fonte 'fixed' do slot", () => {
    const bloco = fonte.slice(fonte.indexOf("async function subirImagem"));
    expect(bloco).toMatch(/kind: "fixed", value: j\.data\.url/);
  });
});
