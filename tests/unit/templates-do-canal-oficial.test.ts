import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * CRIAR MODELO DIRETO NO CANAL OFICIAL — a metade que faltava.
 *
 * Até aqui, a aba "Templates da Meta" só ESPELHAVA (`template-sync.ts`, "não
 * cria, não edita e não é dono de nada"). Criar exigia sair do CRM e entrar no
 * Gerenciador do WhatsApp da Meta. `lib/channels/meta/template-ops.ts` é a
 * peça que faltava — mesmo contrato (`ChannelTemplateOps`) que o canal
 * intermediado já usa, e os casos de conteúdo (idioma por lista, exemplos,
 * botões, mídia) já estão travados em `templates-do-parceiro.test.ts` contra
 * os MESMOS helpers (`lib/channels/template-conteudo.ts`) — não duplicados
 * aqui.
 *
 * Achado ao vivo NO CAMINHO (RevitaFio Mossoró): o POST desta rota lia
 * `META_SYSTEM_USER_TOKEN` do ambiente direto — o mesmo bug do adapter,
 * corrigido junto. Sem isso, mesmo com "Criar modelo" pronto, "Sincronizar"
 * falharia com `missing_meta_token` para todo canal conectado pela tela.
 */
describe("a rota do canal oficial resolve credencial DA SESSÃO, não só do env", () => {
  it("usa resolveMetaCreds — não lê META_SYSTEM_USER_TOKEN direto", () => {
    const fonte = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");
    expect(fonte).toMatch(/resolveMetaCreds\(admin, sessao\.phoneNumberId\)/);
    expect(
      fonte,
      "voltou a ler o token só do ambiente — quebra instalação conectada pela tela",
    ).not.toMatch(/process\.env\.META_SYSTEM_USER_TOKEN \?\? ""/);
  });

  it("não nomeia o provider fora do seam — usa a constante, não o literal", () => {
    // O `lint-channels` reprova string de provider fora de `lib/channels/`; a
    // rota pede o adapter pela CONSTANTE importada, nunca por `"meta_cloud"`.
    const fonte = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");
    expect(fonte).toMatch(/getAdapter\(CHANNEL_PROVIDER_META\)/);
    expect(fonte).not.toMatch(/getAdapter\("meta_cloud"\)/);
  });
});

describe("criar TAMBÉM sincroniza — senão o operador cria a mesma duas vezes", () => {
  it("o corpo com acao:'criar' chama adapter.templates.create antes do sync", () => {
    const fonte = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");
    const iCriar = fonte.indexOf('corpo.acao === "criar"');
    const iCreate = fonte.indexOf("adapter.templates.create");
    const iSync = fonte.indexOf("syncTemplates({");
    expect(iCriar).toBeGreaterThan(-1);
    expect(iCreate).toBeGreaterThan(iCriar);
    expect(iSync).toBeGreaterThan(iCreate);
  });

  it("a criação é auditada", () => {
    const fonte = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");
    expect(fonte).toMatch(/action: "template\.created"/);
  });
});

describe("os elos que somem sem barulho", () => {
  it("a aba oferece 'Criar modelo', não só o espelho", () => {
    const fonte = readFileSync("components/connections/TemplatesClient.tsx", "utf8");
    expect(fonte).toMatch(/Criar modelo/);
    expect(fonte).toMatch(/useCreateTemplate/);
  });

  it("reaproveita os MESMOS helpers do canal intermediado — um contrato só", () => {
    // Se os dois formulários divergissem, um dia um deles pararia de mandar o
    // `example` que a revisão exige e ninguém notaria até a recusa.
    const fonte = readFileSync("components/connections/TemplatesClient.tsx", "utf8");
    expect(fonte).toMatch(/from "@\/lib\/channels\/template-conteudo"/);
    expect(fonte).toMatch(/montarComponents\(\{/);
    expect(fonte).toMatch(/IDIOMAS_DA_DEFINICAO\.map/);
  });

  it("a imagem do cabeçalho sobe pela rota de mídia compartilhada", () => {
    // A rota é neutra de provider (só grava no storage e assina o link) —
    // reaproveitar em vez de duplicar é a checagem que importa aqui.
    const fonte = readFileSync("components/connections/TemplatesClient.tsx", "utf8");
    expect(fonte).toMatch(/\/api\/v1\/channels\/partner\/templates\/media/);
  });

  it("useCreateTemplate invalida o mesmo cache que o sync e o seletor do inbox leem", () => {
    const fonte = readFileSync("hooks/channels/useTemplates.ts", "utf8");
    const bloco = fonte.slice(fonte.indexOf("export function useCreateTemplate"));
    expect(bloco).toMatch(/queryKey: \["channel-templates"\]/);
  });
});
