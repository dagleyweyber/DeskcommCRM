import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A metade que faltava no canal OFICIAL — criar/editar/apagar definição direto
 * na WABA, sem sair do CRM (achado ao vivo: RevitaFio Mossoró pedia isso
 * porque só existia pelo Gerenciador do WhatsApp da Meta).
 *
 * Mesma dupla fonte de credencial do resto do canal (sessão primeiro, env
 * como fallback) — sem mockar o admin client corretamente, o teste vermelharia
 * pelo motivo errado (foi assim que `channel-adapter-meta.test.ts` documenta
 * ter acontecido quando a resolução por sessão entrou).
 */
const sessaoNoBanco: { wabaId: string | null; token: string | null } = {
  wabaId: null,
  token: null,
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: sessaoNoBanco.wabaId
              ? { meta_waba_id: sessaoNoBanco.wabaId, meta_token_encrypted: "\\xdeadbeef" }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "token-da-sessao",
}));

function stubFetch(resposta: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => resposta,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  sessaoNoBanco.wabaId = null;
  sessaoNoBanco.token = null;
});

async function ops() {
  const mod = await import("./template-ops");
  return mod.metaTemplateOps;
}

describe("credencial — sessão primeiro, env como fallback", () => {
  it("com credencial NA SESSÃO, usa a WABA e o token dela", async () => {
    sessaoNoBanco.wabaId = "waba-da-sessao";
    const spy = stubFetch({ data: [] });

    await (await ops()).list({ sessionRef: "5511999999999" });

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/waba-da-sessao/message_templates");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("sem sessão, cai no env — instalação de número único segue funcionando", async () => {
    vi.stubEnv("META_WABA_ID", "waba-do-env");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "token-do-env");
    const spy = stubFetch({ data: [] });

    await (await ops()).list({ sessionRef: "qualquer" });

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/waba-do-env/message_templates");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-do-env");
  });

  it("⭐ sem credencial nem sessão nem env, LANÇA — nunca finge que listou", async () => {
    await expect((await ops()).list({ sessionRef: "x" })).rejects.toThrow(/meta_not_configured/);
  });
});

describe("criar — manda o rascunho direto pro endpoint da WABA", () => {
  it("POST em /{waba}/message_templates com name, category, language e components", async () => {
    sessaoNoBanco.wabaId = "999";
    const spy = stubFetch({ id: "123", status: "PENDING", category: "UTILITY" });

    const r = await (await ops()).create({
      sessionRef: "x",
      draft: {
        name: "confirmacao_agendamento",
        language: "pt_BR",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Olá {{1}}" }],
      },
    });

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/999/message_templates");
    expect(init.method).toBe("POST");
    const corpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(corpo).toMatchObject({
      name: "confirmacao_agendamento",
      category: "UTILITY",
      language: "pt_BR",
    });
    // O nome/idioma não voltam no POST de criação — o rascunho é a fonte.
    expect(r.name).toBe("confirmacao_agendamento");
    expect(r.status).toBe("PENDING");
  });

  it("erro da Meta lança com o `details` — nome duplicado, categoria inválida etc.", async () => {
    sessaoNoBanco.wabaId = "999";
    stubFetch(
      { error: { message: "Invalid parameter", error_data: { details: "nome já existe" } } },
      false,
    );

    await expect(
      (await ops()).create({
        sessionRef: "x",
        draft: { name: "dup", language: "pt_BR", category: "UTILITY", components: [] },
      }),
    ).rejects.toThrow(/nome já existe/);
  });
});

describe("apagar — por nome, como o resto do canal endereça", () => {
  it("DELETE em /{waba}/message_templates?name=...", async () => {
    sessaoNoBanco.wabaId = "999";
    const spy = stubFetch({ success: true });

    await (await ops()).remove({ sessionRef: "x", name: "modelo_antigo" });

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/999/message_templates?");
    expect(url).toContain("name=modelo_antigo");
    expect(init.method).toBe("DELETE");
  });
});

describe("editar — resolve o ID por nome antes, porque a Meta edita por ID", () => {
  it("busca o template por nome e depois faz POST em /{id}", async () => {
    sessaoNoBanco.wabaId = "999";
    const spy = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes("name=")
            ? { data: [{ id: "tpl-42", name: "x", language: "pt_BR", status: "REJECTED" }] }
            : { success: true },
      } as Response;
    });
    vi.stubGlobal("fetch", spy);

    await (await ops()).update({
      sessionRef: "x",
      name: "x",
      patch: { components: [{ type: "BODY", text: "novo texto" }] },
    });

    expect(spy).toHaveBeenCalledTimes(2);
    const [urlEdicao] = spy.mock.calls[1]!;
    expect(urlEdicao).toContain("/tpl-42");
  });

  it("template não encontrado lança com o nome, não um 404 mudo", async () => {
    sessaoNoBanco.wabaId = "999";
    stubFetch({ data: [] });

    await expect(
      (await ops()).update({ sessionRef: "x", name: "sumiu", patch: {} }),
    ).rejects.toThrow(/sumiu/);
  });
});
