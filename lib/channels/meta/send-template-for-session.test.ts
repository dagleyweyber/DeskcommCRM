import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `sendTemplateForSession` lia `META_PHONE_NUMBER_ID`/`META_SYSTEM_USER_TOKEN`
 * direto do `process.env` — sem essas vars setadas em NENHUMA organização
 * desta instalação, todo template mandado pra um cliente de verdade (agente
 * em janela fechada, campanha em massa) saía com credencial vazia e a Meta
 * devolvia `100: Unsupported post request` (achado ao vivo pela campanha).
 * Este teste trava que a credencial vem de `resolveMetaCreds` — sessão
 * primeiro, env como fallback —, nunca do ambiente cru.
 */
const sessaoNoBanco: { phoneNumberId: string | null } = { phoneNumberId: null };

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "token-da-sessao",
}));

function dbFake() {
  return {
    from: (tabela: string) => {
      if (tabela === "channel_sessions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: sessaoNoBanco.phoneNumberId
                  ? { meta_phone_number_id: sessaoNoBanco.phoneNumberId, meta_token_encrypted: "\\xdeadbeef" }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }
      // meta_templates — devolve um template aprovado sem parâmetro, pra
      // não precisar montar `components`/`contract_hash` neste teste.
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    name: "t",
                    language: "pt_BR",
                    status: "APPROVED",
                    contract_hash: "hash-x",
                    components: [{ type: "BODY", text: "Oi" }],
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    },
  } as never;
}

function stubFetch(resposta: unknown) {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resposta });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessaoNoBanco.phoneNumberId = null;
});

describe("credencial vem da SESSÃO, não do process.env cru", () => {
  it("com credencial na sessão, a URL leva o phone_number_id DELA", async () => {
    sessaoNoBanco.phoneNumberId = "1103328999528818";
    const spy = stubFetch({ messages: [{ id: "wamid.OK" }] });

    const { sendTemplateForSession } = await import("./send-template-for-session");
    const externalId = await sendTemplateForSession(dbFake(), {
      organizationId: "org-1",
      phoneNumberId: "1103328999528818",
      to: "5511999999999",
      name: "t",
      language: "pt_BR",
      values: {},
    });

    expect(externalId).toBe("wamid.OK");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/1103328999528818/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("⭐ sem credencial nem sessão nem env, LANÇA — nunca manda URL sem número", async () => {
    sessaoNoBanco.phoneNumberId = null; // sem sessão
    const spy = stubFetch({});

    const { sendTemplateForSession } = await import("./send-template-for-session");
    await expect(
      sendTemplateForSession(dbFake(), {
        organizationId: "org-1",
        phoneNumberId: "algum-numero",
        to: "5511999999999",
        name: "t",
        language: "pt_BR",
        values: {},
      }),
    ).rejects.toThrow(/meta_not_configured/);

    expect(spy).not.toHaveBeenCalled();
  });
});
