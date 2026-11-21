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
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "token-da-sessao",
}));

type Linha = Record<string, unknown>;

/** Banco fingido que aplica de verdade os filtros `eq`/`is` e falha como o PostgREST em >1 linha. */
function dbFake(opts: { sessoes?: Linha[]; modelos?: Linha[] } = {}) {
  const sessoes = opts.sessoes ?? [];
  const modelos = opts.modelos ?? [
    {
      organization_id: "org-1",
      waba_id: "WABA-1",
      name: "t",
      language: "pt_BR",
      status: "APPROVED",
      contract_hash: "hash-x",
      components: [{ type: "BODY", text: "Oi" }],
    },
  ];
  return {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        is: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        maybeSingle: async () => {
          const linhas = tabela === "channel_sessions" ? sessoes : modelos;
          const achadas = linhas.filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
          if (achadas.length > 1) {
            return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
          }
          return { data: achadas[0] ?? null, error: null };
        },
      };
      return q;
    },
  } as never;
}

const sessao = (pnid: string, waba: string): Linha => ({
  organization_id: "org-1",
  meta_phone_number_id: pnid,
  meta_waba_id: waba,
  meta_token_encrypted: "\\xdeadbeef",
  archived_at: null,
});

function stubFetch(resposta: unknown) {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resposta });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("credencial vem da SESSÃO, não do process.env cru", () => {
  it("com credencial na sessão, a URL leva o phone_number_id DELA", async () => {
    const spy = stubFetch({ messages: [{ id: "wamid.OK" }] });

    const { sendTemplateForSession } = await import("./send-template-for-session");
    const resultado = await sendTemplateForSession(dbFake({ sessoes: [sessao("1103328999528818", "WABA-1")] }), {
      organizationId: "org-1",
      phoneNumberId: "1103328999528818",
      to: "5511999999999",
      name: "t",
      language: "pt_BR",
      values: {},
    });

    expect(resultado.externalId).toBe("wamid.OK");
    expect(resultado.headerMedia).toBeNull();
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/1103328999528818/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  /**
   * Achado ao vivo (RevitaFio Mossoró): campanha com cabeçalho de imagem
   * "enviava certo" e a conversa no inbox nunca mostrava a imagem de volta —
   * porque nada capturava qual mídia tinha ido, só o texto. `headerMedia` é
   * o que fecha essa lacuna: quem persiste a mensagem sabe o que guardar.
   */
  it("⭐ template com cabeçalho de imagem devolve headerMedia — é o que falta pro inbox mostrar de volta", async () => {
    stubFetch({ messages: [{ id: "wamid.IMG" }] });
    const db = dbFake({
      sessoes: [sessao("1103328999528818", "WABA-1")],
      modelos: [
        {
          organization_id: "org-1",
          waba_id: "WABA-1",
          name: "t",
          language: "pt_BR",
          status: "APPROVED",
          contract_hash: "hash-x",
          components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Oi" }],
        },
      ],
    });

    const { sendTemplateForSession } = await import("./send-template-for-session");
    const resultado = await sendTemplateForSession(db, {
      organizationId: "org-1",
      phoneNumberId: "1103328999528818",
      to: "5511999999999",
      name: "t",
      language: "pt_BR",
      values: { "header:1": "https://exemplo.com/imagem.jpg" },
    });

    expect(resultado.externalId).toBe("wamid.IMG");
    expect(resultado.headerMedia).toEqual({ kind: "image", url: "https://exemplo.com/imagem.jpg" });
  });

  it("⭐ sem credencial nem sessão nem env, LANÇA — nunca manda URL sem número", async () => {
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

/**
 * Achado ao vivo (B'Laser Parnamirim, 2026-11-21): a campanha da Clara falhou inteira com
 * `template_lookup_failed: ... multiple rows returned`. O modelo tinha o mesmo nome na
 * conta da Recepção e na da Clara, e a busca era só por organização.
 */
describe("o modelo é procurado na conta do NÚMERO que envia", () => {
  const corpo = (texto: string) => [{ type: "BODY", text: texto }];
  const doisNumeros = () =>
    dbFake({
      sessoes: [sessao("PN-RECEPCAO", "WABA-RECEPCAO"), sessao("PN-CLARA", "WABA-CLARA")],
      modelos: [
        { organization_id: "org-1", waba_id: "WABA-RECEPCAO", name: "black", language: "pt_BR", status: "APPROVED", contract_hash: "h1", components: corpo("Recepção") },
        { organization_id: "org-1", waba_id: "WABA-CLARA", name: "black", language: "pt_BR", status: "APPROVED", contract_hash: "h2", components: corpo("Clara") },
      ],
    });

  it("⭐ mesmo nome nos dois números: envia pela Clara com o modelo DA CLARA, sem erro", async () => {
    const spy = stubFetch({ messages: [{ id: "wamid.CLARA" }] });
    const { sendTemplateForSession } = await import("./send-template-for-session");

    const r = await sendTemplateForSession(doisNumeros(), {
      organizationId: "org-1",
      phoneNumberId: "PN-CLARA",
      to: "5584999999999",
      name: "black",
      language: "pt_BR",
      values: {},
    });

    expect(r.externalId).toBe("wamid.CLARA");
    expect(spy.mock.calls[0]![0]).toContain("/PN-CLARA/messages");
  });

  it("modelo que só existe no OUTRO número não é usado — falha como 'não está no espelho'", async () => {
    stubFetch({ messages: [{ id: "nunca" }] });
    const db = dbFake({
      sessoes: [sessao("PN-RECEPCAO", "WABA-RECEPCAO"), sessao("PN-CLARA", "WABA-CLARA")],
      modelos: [
        { organization_id: "org-1", waba_id: "WABA-RECEPCAO", name: "so_recepcao", language: "pt_BR", status: "APPROVED", contract_hash: "h1", components: corpo("x") },
      ],
    });
    const { sendTemplateForSession } = await import("./send-template-for-session");

    await expect(
      sendTemplateForSession(db, {
        organizationId: "org-1",
        phoneNumberId: "PN-CLARA",
        to: "5584999999999",
        name: "so_recepcao",
        language: "pt_BR",
        values: {},
      }),
    ).rejects.toThrow(/template_missing/);
  });
});
