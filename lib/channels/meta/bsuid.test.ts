import { describe, expect, it, vi } from "vitest";

import { metaCloudAdapter } from "../adapters/meta-cloud";
import { destinoNoCorpo, ehBsuid } from "./endereco";
import { resolverContatoMeta } from "./ingest";
import { parseMetaWebhook } from "./webhook";

/**
 * A Meta passou a OMITIR o telefone de quem ativa o nome de usuário; o BSUID é o único
 * identificador que sempre vem. O que se trava aqui é que isso nunca vira mensagem
 * descartada em silêncio, e que o caminho por telefone segue exatamente como era.
 */
// O adapter resolve a credencial POR SESSÃO (banco) antes do env; sem mockar o admin, o
// `fetch` stubbado capturaria a consulta do Supabase em vez da chamada à Graph API.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => {
          const consulta = { is: () => consulta, maybeSingle: async () => ({ data: null, error: null }) };
          return consulta;
        },
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const META = { display_phone_number: "5581995191160", phone_number_id: "PN1" };
const envelope = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: META, ...value } }] }],
});

describe("ehBsuid / destinoNoCorpo", () => {
  it("reconhece o formato da Meta (país + ponto + alfanumérico) e o BSUID pai", () => {
    expect(ehBsuid("BR.13491208655302741918")).toBe(true);
    expect(ehBsuid("US.ENT.11815799212886844830")).toBe(true);
  });

  it("⭐ telefone NUNCA é confundido com BSUID (senão `to` viraria `recipient` e o envio falharia)", () => {
    expect(ehBsuid("5581995191160")).toBe(false);
    expect(ehBsuid("+5581995191160")).toBe(false);
    expect(ehBsuid("")).toBe(false);
    expect(ehBsuid(null)).toBe(false);
    expect(ehBsuid("B.123")).toBe(false);
    expect(ehBsuid("BR123")).toBe(false);
  });

  it("telefone vai em `to`; BSUID vai em `recipient` (doc da Meta), intacto", () => {
    expect(destinoNoCorpo("5581995191160")).toEqual({ to: "5581995191160" });
    expect(destinoNoCorpo("BR.13491208655302741918")).toEqual({
      recipient_type: "individual",
      recipient: "BR.13491208655302741918",
    });
  });
});

describe("mensagem de entrada sem telefone", () => {
  it("⭐ só com `from_user_id`: vira evento (antes era descartada em silêncio)", () => {
    const [e] = parseMetaWebhook(
      envelope("messages", {
        contacts: [{ user_id: "BR.111", profile: { name: "Ana", username: "ana.s" } }],
        messages: [{ from_user_id: "BR.111", id: "wamid.B1", timestamp: "1700000000", type: "text", text: { body: "oi" } }],
      }),
    );
    expect(e).toMatchObject({
      kind: "inbound_message",
      from: null,
      userId: "BR.111",
      profileName: "Ana",
      text: "oi",
      externalId: "wamid.B1",
    });
  });

  it("com telefone E BSUID: traz os dois (é assim que se vincula a mesma pessoa)", () => {
    const [e] = parseMetaWebhook(
      envelope("messages", {
        contacts: [{ wa_id: "5581999990000", user_id: "BR.222", profile: { name: "Bia" } }],
        messages: [{ from: "5581999990000", from_user_id: "BR.222", id: "wamid.B2", timestamp: "1700000000", type: "text", text: { body: "oi" } }],
      }),
    );
    expect(e).toMatchObject({ from: "5581999990000", userId: "BR.222", profileName: "Bia" });
  });

  it("o BSUID pode vir só em `contacts[].user_id`", () => {
    const [e] = parseMetaWebhook(
      envelope("messages", {
        contacts: [{ wa_id: "5581999990000", user_id: "BR.333", profile: { name: "Caio" } }],
        messages: [{ from: "5581999990000", id: "wamid.B3", timestamp: "1700000000", type: "text", text: { body: "oi" } }],
      }),
    );
    expect(e).toMatchObject({ from: "5581999990000", userId: "BR.333" });
  });

  it("sem NENHUM identificador continua sendo payload capenga", () => {
    expect(
      parseMetaWebhook(
        envelope("messages", { messages: [{ id: "wamid.B4", timestamp: "1", type: "text", text: { body: "x" } }] }),
      ),
    ).toEqual([]);
  });

  it("o caso de sempre (só telefone) segue idêntico, com userId nulo", () => {
    const [e] = parseMetaWebhook(
      envelope("messages", {
        contacts: [{ wa_id: "5581999990000", profile: { name: "Dani" } }],
        messages: [{ from: "5581999990000", id: "wamid.B5", timestamp: "1700000000", type: "text", text: { body: "oi" } }],
      }),
    );
    expect(e).toMatchObject({ from: "5581999990000", userId: null });
  });
});

describe("eco e histórico sem telefone", () => {
  it("eco só com `to_user_id`", () => {
    const [e] = parseMetaWebhook(
      envelope("smb_message_echoes", {
        message_echoes: [{ from: "5581995191160", to_user_id: "BR.444", id: "wamid.E1", timestamp: "1700000000", type: "text", text: { body: "ok" } }],
      }),
    );
    expect(e).toMatchObject({ kind: "echo", to: null, toUserId: "BR.444" });
  });

  it("eco sem telefone nem BSUID é descartado", () => {
    expect(
      parseMetaWebhook(
        envelope("smb_message_echoes", {
          message_echoes: [{ from: "x", id: "wamid.E2", timestamp: "1", type: "text", text: { body: "ok" } }],
        }),
      ),
    ).toEqual([]);
  });

  it("⭐ thread identificada por BSUID: o contato é o BSUID, e a direção segue `from_user_id`", () => {
    const [e] = parseMetaWebhook(
      envelope("history", {
        history: [
          {
            metadata: { phase: 1, chunk_order: 0, progress: 50 },
            threads: [
              {
                id: "BR.555",
                messages: [
                  { from_user_id: "BR.555", id: "m1", timestamp: "1700000000", type: "text", text: { body: "oi" } },
                  { from: "5581995191160", id: "m2", timestamp: "1700000100", type: "text", text: { body: "olá" } },
                ],
              },
            ],
          },
        ],
      }),
    );
    if (e?.kind !== "history_chunk") throw new Error("tipo");
    expect(e.threads[0]).toMatchObject({ contactPhone: null, contactUserId: "BR.555" });
    expect(e.threads[0]!.messages.map((m) => [m.externalId, m.inbound])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
  });

  it("thread por telefone segue como sempre", () => {
    const [e] = parseMetaWebhook(
      envelope("history", {
        history: [{ metadata: { phase: 0 }, threads: [{ id: "5581999990000", messages: [{ from: "5581999990000", id: "m1", timestamp: "1", type: "text", text: { body: "x" } }] }] }],
      }),
    );
    if (e?.kind !== "history_chunk") throw new Error("tipo");
    expect(e.threads[0]).toMatchObject({ contactPhone: "5581999990000", contactUserId: null });
  });
});

describe("resolverContatoMeta — qual função de contato é chamada", () => {
  function adminFalso(existente: { id: string; phone_number: string } | null = null) {
    const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
    const admin = {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        rpcs.push({ nome, args });
        return { data: "contact-1", error: null };
      },
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.in = () => q;
        q.limit = () => q;
        q.maybeSingle = async () => ({ data: existente, error: null });
        return q;
      },
    };
    return { admin: admin as never, rpcs };
  }

  it("⭐ só telefone: o caminho de SEMPRE (fn_upsert_wa_contact), sem tocar na função nova", async () => {
    const { admin, rpcs } = adminFalso();
    const r = await resolverContatoMeta(admin, "org-1", { phone: "5581999990000", nome: "Ana" });
    expect(r).toEqual({ id: "contact-1" });
    expect(rpcs.map((x) => x.nome)).toEqual(["fn_upsert_wa_contact"]);
    expect(rpcs[0]!.args).toMatchObject({ p_kind: "phone", p_phone: "+5581999990000", p_notify: "Ana" });
  });

  it("BSUID sem telefone: função nova, com p_phone nulo", async () => {
    const { admin, rpcs } = adminFalso();
    const r = await resolverContatoMeta(admin, "org-1", { bsuid: "BR.111", nome: "Ana" });
    expect(r).toEqual({ id: "contact-1" });
    expect(rpcs).toEqual([
      { nome: "fn_upsert_wa_contact_bsuid", args: { p_org: "org-1", p_bsuid: "BR.111", p_phone: null, p_notify: "Ana" } },
    ]);
  });

  it("BSUID com telefone: usa o número JÁ cadastrado (nono dígito) para vincular, não o do evento", async () => {
    const { admin, rpcs } = adminFalso({ id: "c1", phone_number: "+5531998966398" });
    await resolverContatoMeta(admin, "org-1", { phone: "553198966398", bsuid: "BR.111" });
    expect(rpcs[0]!.nome).toBe("fn_upsert_wa_contact_bsuid");
    expect(rpcs[0]!.args.p_phone).toBe("+5531998966398");
  });

  it("nem telefone nem BSUID: erro explícito, nada gravado", async () => {
    const { admin, rpcs } = adminFalso();
    expect(await resolverContatoMeta(admin, "org-1", {})).toEqual({ erro: "sem telefone nem bsuid" });
    expect(rpcs).toEqual([]);
  });
});

describe("envio por BSUID", () => {
  it("resolveRecipient: com telefone, o telefone (como sempre); sem telefone, o BSUID", async () => {
    const base = { isGroup: false, groupChatId: null, waIdentity: null };
    await expect(
      metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: "+55 81 99999-0000", waBsuid: "BR.111" }),
    ).resolves.toBe("5581999990000");
    await expect(
      metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: null, waBsuid: "BR.111" }),
    ).resolves.toBe("BR.111");
    await expect(
      metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: null, waBsuid: null }),
    ).resolves.toBeNull();
  });

  it("⭐ um `waBsuid` que NÃO tem o formato da Meta não vira endereço", async () => {
    await expect(
      metaCloudAdapter.resolveRecipient({ isGroup: false, groupChatId: null, waIdentity: null, phoneNumber: null, waBsuid: "lixo" }),
    ).resolves.toBeNull();
  });

  it("send: BSUID vai em `recipient`, e NÃO em `to`", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) });
    vi.stubGlobal("fetch", spy);
    vi.stubEnv("META_PHONE_NUMBER_ID", "PN1");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
    try {
      await metaCloudAdapter.send({ sessionRef: "x", to: "BR.111", kind: "text", body: "oi" });
      const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as Record<string, unknown>;
      expect(corpo).toMatchObject({ recipient_type: "individual", recipient: "BR.111", type: "text" });
      expect(corpo).not.toHaveProperty("to");

      spy.mockClear();
      await metaCloudAdapter.send({ sessionRef: "x", to: "5581999990000", kind: "text", body: "oi" });
      const corpo2 = JSON.parse(spy.mock.calls[0]![1].body as string) as Record<string, unknown>;
      expect(corpo2).toMatchObject({ to: "5581999990000" });
      expect(corpo2).not.toHaveProperty("recipient");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
