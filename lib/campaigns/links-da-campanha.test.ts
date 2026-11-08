import { describe, expect, it } from "vitest";

import {
  ehLinkDaCampanha,
  montarComponents,
  problemasDosBotoes,
  slotsDeLinkDaCampanha,
} from "@/lib/channels/template-conteudo";

import { gerarCodigoDoLink, prepararLinks } from "./links-da-campanha";

const aprovado = [
  { type: "BODY", text: "Olá {{1}}" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Sim" },
      { type: "URL", text: "Entrar no grupo", url: "https://crm.exemplo.com/l/{{1}}" },
    ],
  },
];

describe("definição do modelo com link escolhido na campanha", () => {
  it("vai para a revisão com <crm>/l/{{1}} e um exemplo completo", () => {
    const c = montarComponents({
      body: "Oi",
      exemplos: [],
      botoes: [{ tipo: "url", texto: "Entrar no grupo", linkNaCampanha: true }],
      origemDoLink: "https://crm.exemplo.com/",
    }) as Array<{ type: string; buttons?: unknown[] }>;
    expect(c.find((x) => x.type === "BUTTONS")?.buttons).toEqual([
      {
        type: "URL",
        text: "Entrar no grupo",
        url: "https://crm.exemplo.com/l/{{1}}",
        example: ["https://crm.exemplo.com/l/exemplo"],
      },
    ]);
  });

  it("avisa em vez de sumir com o botão sem endereço", () => {
    expect(problemasDosBotoes([{ tipo: "url", texto: "Grupo VIP" }])[0]).toMatch(/falta o endereço/);
    expect(problemasDosBotoes([{ tipo: "url", texto: "Grupo", linkNaCampanha: true }])).toEqual([]);
  });

  it("recusa link do WhatsApp no botão fixo, antes da Meta", () => {
    for (const url of ["https://chat.whatsapp.com/AbC", "https://wa.me/5584999", "wa.me/5584"]) {
      expect(problemasDosBotoes([{ tipo: "url", texto: "Grupo", url }])[0]).toMatch(/não aceita link do WhatsApp/);
    }
    expect(problemasDosBotoes([{ tipo: "url", texto: "Site", url: "https://blaser.com.br" }])).toEqual([]);
  });

  it("acha o slot do botão pela posição na lista de botões", () => {
    expect(slotsDeLinkDaCampanha(aprovado)).toEqual(["button1:1"]);
    expect(ehLinkDaCampanha("https://site.com/promo/{{1}}")).toBe(false);
  });
});

describe("prepararLinks", () => {
  it("troca o destino colado por um código e devolve o que gravar", () => {
    const r = prepararLinks(
      aprovado,
      { "1": { kind: "contact_first_name" }, "button1:1": { kind: "fixed", value: "https://chat.whatsapp.com/AbC" } },
      () => "Codigo1234",
    );
    expect(r).toEqual({
      ok: true,
      mapping: { "1": { kind: "contact_first_name" }, "button1:1": { kind: "fixed", value: "Codigo1234" } },
      links: [{ slot: "button1:1", codigo: "Codigo1234", destino: "https://chat.whatsapp.com/AbC" }],
    });
  });

  it("recusa destino que não é link", () => {
    const r = prepararLinks(aprovado, { "button1:1": { kind: "fixed", value: "grupo vip" } });
    expect(r.ok).toBe(false);
  });

  it("modelo sem botão de link não muda nada", () => {
    const mapping = { "1": { kind: "fixed" as const, value: "x" } };
    expect(prepararLinks([{ type: "BODY", text: "{{1}}" }], mapping)).toEqual({ ok: true, mapping, links: [] });
  });

  it("código casa com o que a rota pública e o CHECK aceitam", () => {
    for (let i = 0; i < 50; i++) expect(gerarCodigoDoLink()).toMatch(/^[A-Za-z0-9]{8,32}$/);
  });
});
