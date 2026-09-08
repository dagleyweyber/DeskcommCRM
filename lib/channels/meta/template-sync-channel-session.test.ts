import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `meta_templates.channel_session_id` existe desde a migration 0154, mas
 * `syncTemplates` nunca escrevia nela — achado ao vivo pela campanha em massa
 * (0167), a primeira leitura a endereçar "o template DESTA conexão" e achar
 * zero linha para um modelo genuinamente aprovado. Backfill dos dados velhos
 * é a migration 0168; este teste trava que o código não regride pra nascer
 * nulo de novo.
 */
const upsertSpy = vi.fn(async (_rows: unknown, _opts: unknown) => ({ error: null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
      }),
      upsert: upsertSpy,
    }),
  }),
}));

function stubFetch(resposta: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resposta }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  upsertSpy.mockClear();
});

describe("syncTemplates grava channel_session_id em cada linha", () => {
  it("⭐ o upsert leva channel_session_id — não nasce nulo de novo", async () => {
    stubFetch({
      data: [{ name: "t", language: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Oi" }] }],
    });

    const { syncTemplates } = await import("./template-sync");
    await syncTemplates({
      organizationId: "org-1",
      wabaId: "waba-1",
      channelSessionId: "sessao-123",
      token: "tok",
      graphVersion: "v22.0",
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [linhas] = upsertSpy.mock.calls[0]!;
    expect(linhas).toHaveLength(1);
    expect((linhas as Array<{ channel_session_id: string }>)[0]!.channel_session_id).toBe(
      "sessao-123",
    );
  });

  it("payload vazio não chama upsert — nada pra travar aqui", async () => {
    stubFetch({ data: [] });

    const { syncTemplates } = await import("./template-sync");
    await syncTemplates({
      organizationId: "org-1",
      wabaId: "waba-1",
      channelSessionId: "sessao-123",
      token: "tok",
      graphVersion: "v22.0",
    });

    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
