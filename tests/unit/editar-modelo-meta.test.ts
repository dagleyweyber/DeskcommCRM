import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formularioDeComponents,
  montarComponents,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";

/**
 * EDITAR MODELO JÁ APROVADO NO CANAL OFICIAL (pedido da B'Laser, 2026-11-12).
 *
 * O adapter já sabia editar (`metaTemplateOps.update`), mas nada o chamava: a rota só
 * tinha sincronizar/criar/apagar e a tela não tinha o botão. Aqui trava-se o que a
 * edição precisa para não perder conteúdo em silêncio.
 */
describe("formularioDeComponents — o caminho inverso do montarComponents", () => {
  it("⭐ o que a tela monta volta idêntico ao abrir para editar", () => {
    const botoes: BotaoDaDefinicao[] = [
      { tipo: "quick_reply", texto: "Confirmar" },
      { tipo: "url", texto: "Ver", url: "https://exemplo.com/x" },
      { tipo: "phone_number", texto: "Ligar", telefone: "+5584999999999" },
    ];
    const components = montarComponents({
      body: "Oi {{1}}, sua consulta é {{2}}.",
      footer: "B'Laser",
      exemplos: ["Maria", "amanhã"],
      cabecalho: { texto: "Lembrete" },
      botoes,
      origemDoLink: "https://crm.exemplo.com",
    });
    const f = formularioDeComponents(components);
    expect(f.corpo).toBe("Oi {{1}}, sua consulta é {{2}}.");
    expect(f.rodape).toBe("B'Laser");
    expect(f.cabecalhoTexto).toBe("Lembrete");
    expect(f.exemplos).toEqual(["Maria", "amanhã"]);
    expect(f.botoes).toEqual(botoes);
    expect(f.temBotaoNaoSuportado).toBe(false);
  });

  it("botão de link da campanha volta como 'link escolhido na campanha', não como URL fixa", () => {
    const components = montarComponents({
      body: "Veja",
      exemplos: [],
      botoes: [{ tipo: "url", texto: "Entrar", linkNaCampanha: true }],
      origemDoLink: "https://crm.exemplo.com",
    });
    expect(formularioDeComponents(components).botoes).toEqual([
      { tipo: "url", texto: "Entrar", linkNaCampanha: true },
    ]);
  });

  it("a Meta devolve tipos em MAIÚSCULAS e sem rodapé: tolerante", () => {
    const f = formularioDeComponents([{ type: "BODY", text: "Só o corpo" }]);
    expect(f.corpo).toBe("Só o corpo");
    expect(f.rodape).toBe("");
    expect(f.botoes).toEqual([]);
    expect(f.cabecalhoDeMidia).toBe(false);
  });

  it("⭐ cabeçalho de imagem é sinalizado: o handle não volta, a tela exige subir de novo", () => {
    const f = formularioDeComponents([
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://temporario"] } },
      { type: "BODY", text: "Oi" },
    ]);
    expect(f.cabecalhoDeMidia).toBe(true);
    expect(f.cabecalhoTexto).toBe("");
  });

  it("⭐ botão que a tela não sabe reescrever é sinalizado, para não ser perdido ao salvar", () => {
    const f = formularioDeComponents([
      { type: "BODY", text: "Oi" },
      { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "123" }, { type: "QUICK_REPLY", text: "Ok" }] },
    ]);
    expect(f.temBotaoNaoSuportado).toBe(true);
    expect(f.botoes).toEqual([{ tipo: "quick_reply", texto: "Ok" }]);
  });

  it("entrada inválida não quebra", () => {
    expect(formularioDeComponents(null).corpo).toBe("");
    expect(formularioDeComponents([null, 3, "x"]).botoes).toEqual([]);
  });
});

describe("a rota edita só o que a Meta deixa, e deixa rastro", () => {
  const rota = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");

  it("acao:'editar' chama adapter.templates.update antes do sync, com o idioma", () => {
    const iEditar = rota.indexOf('corpo.acao === "editar"');
    const iUpdate = rota.indexOf("adapter.templates.update");
    const iSync = rota.indexOf("syncTemplates({");
    expect(iEditar).toBeGreaterThan(-1);
    expect(iUpdate).toBeGreaterThan(iEditar);
    expect(iSync).toBeGreaterThan(iUpdate);
    expect(rota.slice(iUpdate, iUpdate + 300)).toMatch(/language: corpo\.language/);
  });

  it("modelo em revisão (PENDING) é barrado com 409 e motivo, não com erro genérico da Meta", () => {
    expect(rota).toMatch(/STATUS_EDITAVEL = \["APPROVED", "REJECTED", "PAUSED"\]/);
    expect(rota).toMatch(/em revisão na Meta/);
  });

  it("a categoria NÃO vai no patch: a Meta não deixa trocar a de um modelo aprovado", () => {
    const iUpdate = rota.indexOf("adapter.templates.update");
    const bloco = rota.slice(iUpdate, rota.indexOf("await audit", iUpdate));
    expect(bloco).toMatch(/patch: \{ components: corpo\.components \}/);
    expect(bloco).not.toMatch(/category/);
  });

  it("a edição é auditada e a busca do modelo é da organização da sessão", () => {
    expect(rota).toMatch(/action: "template\.updated"/);
    const iEditar = rota.indexOf('corpo.acao === "editar"');
    expect(rota.slice(iEditar, iEditar + 900)).toMatch(/\.eq\("organization_id", r\.orgId\)/);
  });

  it("a rota de usos filtra pela organização da sessão, nunca da query", () => {
    const usos = readFileSync("app/api/v1/channels/templates/usos/route.ts", "utf8");
    expect(usos).toMatch(/usosDoModelo\(createAdminClient\(\), org\.orgId/);
    expect(usos).toMatch(/ROLE_RANK\.admin/);
  });
});

describe("a tela oferece editar só onde a Meta aceita", () => {
  const tela = readFileSync("components/connections/TemplatesClient.tsx", "utf8");

  it("botão 'editar' só para APPROVED/REJECTED/PAUSED", () => {
    expect(tela).toMatch(/\["APPROVED", "REJECTED", "PAUSED"\]\.includes\(t\.status\)/);
    expect(tela).toMatch(/data-testid="btn-editar-modelo"/);
  });

  it("nome, idioma e categoria ficam travados na edição", () => {
    for (const rotulo of ["Nome do modelo", "Idioma", "Categoria"]) {
      const i = tela.indexOf(`aria-label="${rotulo}"`);
      expect(i, rotulo).toBeGreaterThan(-1);
      expect(tela.slice(i, i + 80), rotulo).toMatch(/disabled=\{emEdicao\}/);
    }
  });

  it("avisa onde o modelo é usado e invalida o mesmo cache que o sync", () => {
    expect(tela).toMatch(/data-testid="aviso-usos-do-modelo"/);
    const hook = readFileSync("hooks/channels/useTemplates.ts", "utf8");
    const bloco = hook.slice(hook.indexOf("export function useEditTemplate"));
    expect(bloco).toMatch(/queryKey: \["channel-templates"\]/);
    expect(bloco).toMatch(/acao: "editar"/);
  });
});
