import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * VÁRIOS NÚMEROS OFICIAIS NA MESMA ORGANIZAÇÃO (achado ao vivo, B'Laser Parnamirim, 2026-11-19).
 *
 * A Recepção estava conectada por coexistência. Conectar o número da Clara pelo mesmo botão
 * procurou "a linha oficial da organização" e a REGRAVOU: a Recepção parou de receber (o
 * webhook dela passou a ser descartado por WABA diferente), as automações de confirmação
 * ficaram apontando para modelos de outra conta e o histórico da Clara (~1.500 mensagens)
 * caiu dentro das conversas da Recepção. Nenhuma linha de auditoria registrou a troca.
 *
 * A regra agora: um canal oficial é identificado pelo NÚMERO (`meta_phone_number_id`).
 */

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

type Linha = Record<string, unknown>;

function bancoFingido(linhas: Linha[]) {
  const escritas: Array<{ tipo: string; patch: Linha; filtros: Array<[string, unknown]> }> = [];
  class Q implements PromiseLike<unknown> {
    filtros: Array<[string, unknown]> = [];
    unica = false;
    constructor(
      readonly op: "select" | "update" | "insert",
      readonly patch: Linha | null = null,
    ) {}
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filtros.push([c, v]);
      return this;
    }
    is(c: string, v: unknown) {
      this.filtros.push([c, v]);
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      this.unica = true;
      return this;
    }
    maybeSingle() {
      this.unica = true;
      return this;
    }
    private casam() {
      return linhas.filter((l) => this.filtros.every(([c, v]) => (l[c] ?? null) === v));
    }
    private executar() {
      if (this.op === "select") {
        const achadas = this.casam();
        return { data: this.unica ? (achadas[0] ?? null) : achadas, error: null };
      }
      escritas.push({ tipo: this.op, patch: this.patch ?? {}, filtros: this.filtros });
      if (this.op === "insert") {
        const nova = { id: `nova-${linhas.length}`, archived_at: null, ...(this.patch ?? {}) };
        linhas.push(nova);
        return { data: nova, error: null };
      }
      for (const l of this.casam()) Object.assign(l, this.patch);
      return { data: null, error: null };
    }
    then<A, B>(ok?: ((v: unknown) => A) | null, err?: ((e: unknown) => B) | null) {
      return Promise.resolve(this.executar()).then(ok, err);
    }
  }
  const admin = {
    from: () => ({
      select: () => new Q("select"),
      update: (p: Linha) => new Q("update", p),
      insert: (p: Linha) => new Q("insert", p),
    }),
  };
  return { admin, escritas, linhas };
}

const ORG = "org-1";
const recepcao = (): Linha => ({
  id: "recepcao",
  organization_id: ORG,
  provider: "meta_cloud",
  meta_phone_number_id: "PN-RECEPCAO",
  meta_waba_id: "WABA-RECEPCAO",
  meta_token_encrypted: "token-recepcao",
  archived_at: null,
});
const linhaDaClara = {
  organization_id: ORG,
  provider: "meta_cloud" as const,
  meta_phone_number_id: "PN-CLARA",
  meta_waba_id: "WABA-CLARA",
  meta_token_encrypted: "token-clara",
};
const ator = { userId: "u1", requestId: "r1", metadata: {} };

describe("gravarSessaoOficial — o número decide a linha", () => {
  beforeEach(() => vi.resetModules());

  it("⭐ número NOVO na org: cria linha própria e a do outro número fica intacta", async () => {
    const { gravarSessaoOficial } = await import("@/lib/channels/meta/gravar-sessao");
    const db = bancoFingido([recepcao()]);

    const r = await gravarSessaoOficial(db.admin as never, { linha: linhaDaClara, segredoCifrado: "s", ator });

    expect(r).toMatchObject({ ok: true, criada: true });
    expect(db.escritas.map((e) => e.tipo)).toEqual(["insert"]);
    expect(db.linhas[0]).toMatchObject({
      id: "recepcao",
      meta_phone_number_id: "PN-RECEPCAO",
      meta_waba_id: "WABA-RECEPCAO",
      meta_token_encrypted: "token-recepcao",
    });
  });

  it("⭐ o MESMO número de novo: atualiza a linha dele, sem criar outra", async () => {
    const { gravarSessaoOficial } = await import("@/lib/channels/meta/gravar-sessao");
    const db = bancoFingido([recepcao()]);

    const r = await gravarSessaoOficial(db.admin as never, {
      linha: { ...linhaDaClara, meta_phone_number_id: "PN-RECEPCAO", meta_token_encrypted: "token-novo" },
      segredoCifrado: "s",
      ator,
    });

    expect(r).toMatchObject({ ok: true, criada: false, channelSessionId: "recepcao" });
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
    // O update mira a linha pelo id — nunca "a linha oficial da org".
    expect(db.escritas[0]!.filtros).toContainEqual(["id", "recepcao"]);
    expect(db.linhas).toHaveLength(1);
  });

  it("número que só existe EXCLUÍDO volta à vida na linha dele", async () => {
    const { gravarSessaoOficial } = await import("@/lib/channels/meta/gravar-sessao");
    const db = bancoFingido([{ ...recepcao(), archived_at: "2026-11-01T00:00:00Z" }]);

    const r = await gravarSessaoOficial(db.admin as never, {
      linha: { ...linhaDaClara, meta_phone_number_id: "PN-RECEPCAO" },
      segredoCifrado: "s",
      ator,
    });

    expect(r).toMatchObject({ ok: true, criada: false, channelSessionId: "recepcao" });
    expect(db.linhas[0]!.archived_at).toBeNull();
  });

  it("número de OUTRA organização não é achado como 'o mesmo número'", async () => {
    const { gravarSessaoOficial } = await import("@/lib/channels/meta/gravar-sessao");
    const db = bancoFingido([{ ...recepcao(), organization_id: "outra-org", meta_phone_number_id: "PN-CLARA" }]);

    const r = await gravarSessaoOficial(db.admin as never, { linha: linhaDaClara, segredoCifrado: "s", ator });

    expect(r).toMatchObject({ ok: true, criada: true });
    expect(db.linhas[0]!.organization_id).toBe("outra-org");
  });
});

describe("as rotas de conexão gravam pela regra do número", () => {
  const embedded = readFileSync("app/api/v1/channels/official/embedded/route.ts", "utf8");
  const manual = readFileSync("app/api/v1/channels/official/route.ts", "utf8");

  it("⭐ nenhuma das duas procura mais 'a linha oficial da organização' para gravar", () => {
    for (const fonte of [embedded, manual]) {
      expect(fonte).toMatch(/gravarSessaoOficial\(admin/);
      expect(fonte).not.toMatch(/reactivateChannelSession/);
    }
  });

  it("o popup lê a sessão de volta PELO ID gravado, não por provider + maybeSingle", () => {
    const i = embedded.indexOf("// 4. a URL de webhook");
    expect(embedded.slice(i, i + 500)).toMatch(/\.eq\("id", sessaoId\)/);
  });

  it("a trava de coexistência da conexão manual vale só para o MESMO número", () => {
    const i = manual.indexOf("const { data: coexistente }");
    expect(manual.slice(i, i + 400)).toMatch(/\.eq\("meta_phone_number_id", phone_number_id\)/);
  });

  it("o GET devolve todos os números (`numbers`), sem maybeSingle", () => {
    const i = manual.indexOf("export async function GET");
    const get = manual.slice(i, manual.indexOf("export async function POST"));
    expect(get).toMatch(/numbers,/);
    expect(get).not.toMatch(/\.maybeSingle\(\)/);
  });
});

describe("ações sobre um número escolhido", () => {
  it("⭐ reativar com vários números em coexistência exige dizer qual (nunca adivinha)", () => {
    const fonte = readFileSync("app/api/v1/channels/official/embedded/reativar/route.ts", "utf8");
    expect(fonte).toMatch(/channel_session_id: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(fonte).toMatch(/\(candidatas \?\? \[\]\)\.length > 1/);
    expect(fonte).not.toMatch(/maybeSingle/);
  });

  it("modelos: criar/editar/sincronizar/apagar/imagem agem no número escolhido", () => {
    const rota = readFileSync("app/api/v1/channels/templates/route.ts", "utf8");
    const media = readFileSync("app/api/v1/channels/templates/media/route.ts", "utf8");
    expect(rota).not.toMatch(/metaSessionForOrg/);
    expect(rota.match(/metaSessionEscolhida\(/g)?.length).toBe(3);
    expect(media).toMatch(/metaSessionEscolhida\(org\.orgId/);
  });

  it("metaSessionEscolhida só aceita sessão oficial ATIVA da organização da sessão", () => {
    const fonte = readFileSync("lib/channels/meta/session.ts", "utf8");
    const i = fonte.indexOf("export async function metaSessionEscolhida");
    const corpo = fonte.slice(i, fonte.indexOf("type AdminClient", i));
    expect(corpo).toMatch(/\.eq\("organization_id", organizationId\)/);
    expect(corpo).toMatch(/\.eq\("provider", CHANNEL_PROVIDER_META\)/);
    expect(corpo).toMatch(/\.is\(ARCHIVED_AT, null\)/);
  });

  it("a tela de modelos mostra o seletor de número e passa o escolhido para todas as ações", () => {
    const tela = readFileSync("components/connections/TemplatesClient.tsx", "utf8");
    expect(tela).toMatch(/data-testid="templates-seletor-numero"/);
    for (const hook of ["useSyncTemplates(numeroId)", "useCreateTemplate(numeroId)", "useEditTemplate(numeroId)", "useDeleteTemplate(numeroId)"]) {
      expect(tela, hook).toContain(hook);
    }
    expect(tela).toMatch(/fd\.append\("channel_session_id", numeroId\)/);
  });
});
