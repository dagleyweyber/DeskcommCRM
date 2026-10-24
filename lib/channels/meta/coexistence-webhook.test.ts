import { describe, expect, it } from "vitest";

import { parseMetaWebhook } from "./webhook";

const META = { display_phone_number: "5584999990000", phone_number_id: "PN1" };
const envelope = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: META, ...value } }] }],
});

describe("smb_message_echoes — o dono digitou no celular", () => {
  it("texto vira eco com o CONTATO em `to`, nunca o número do negócio", () => {
    const ev = parseMetaWebhook(
      envelope("smb_message_echoes", {
        message_echoes: [
          { from: "5584999990000", to: "5584988887777", id: "wamid.E1", timestamp: "1700000000", type: "text", text: { body: "oi" } },
        ],
      }),
    );
    expect(ev).toEqual([
      expect.objectContaining({
        kind: "echo", wabaId: "W1", phoneNumberId: "PN1", externalId: "wamid.E1",
        to: "5584988887777", type: "text", text: "oi", media: null,
      }),
    ]);
    expect(ev[0]).toMatchObject({ sentAt: new Date(1700000000 * 1000) });
  });

  it("imagem leva legenda como texto e o id da mídia", () => {
    const [e] = parseMetaWebhook(
      envelope("smb_message_echoes", {
        message_echoes: [
          { from: "x", to: "5584988887777", id: "wamid.E2", timestamp: "1700000000", type: "image",
            image: { id: "MID", mime_type: "image/jpeg", caption: "olha" } },
        ],
      }),
    );
    expect(e).toMatchObject({ kind: "echo", text: "olha", media: { id: "MID", mime: "image/jpeg" } });
  });

  it("⭐ revoke e edit são IGNORADOS — não viram mensagem nova", () => {
    const ev = parseMetaWebhook(
      envelope("smb_message_echoes", {
        message_echoes: [
          { from: "x", to: "y", id: "wamid.R", timestamp: "1", type: "revoke", revoke: { original_message_id: "o" } },
          { from: "x", to: "y", id: "wamid.D", timestamp: "1", type: "edit", edit: { original_message_id: "o" } },
        ],
      }),
    );
    expect(ev).toEqual([]);
  });

  it("sem id ou sem destinatário não vira linha meia-boca", () => {
    expect(
      parseMetaWebhook(envelope("smb_message_echoes", { message_echoes: [{ to: "y", type: "text" }, { id: "a", type: "text" }] })),
    ).toEqual([]);
  });
});

describe("history", () => {
  it("bloco normal: direção decidida por quem é `from` na conversa", () => {
    const [e] = parseMetaWebhook(
      envelope("history", {
        history: [
          {
            metadata: { phase: 1, chunk_order: 2, progress: 40 },
            threads: [
              {
                id: "5584988887777",
                messages: [
                  { from: "5584988887777", id: "m1", timestamp: "1700000000", type: "text", text: { body: "oi" }, history_context: { status: "READ" } },
                  { from: "5584999990000", to: "5584988887777", id: "m2", timestamp: "1700000100", type: "text", text: { body: "olá!" }, history_context: { status: "DELIVERED" } },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(e).toMatchObject({ kind: "history_chunk", phase: 1, chunkOrder: 2, progress: 40, phoneNumberId: "PN1" });
    if (e?.kind !== "history_chunk") throw new Error("tipo");
    expect(e.threads[0]!.contactPhone).toBe("5584988887777");
    expect(e.threads[0]!.messages.map((m) => [m.externalId, m.inbound, m.status])).toEqual([
      ["m1", true, "READ"],
      ["m2", false, "DELIVERED"],
    ]);
  });

  it("recusa (2593109) DENTRO do envelope", () => {
    const [e] = parseMetaWebhook(
      envelope("history", { history: [{ errors: [{ code: 2593109, title: "recusou" }] }] }),
    );
    expect(e).toMatchObject({ kind: "history_declined", code: 2593109, phoneNumberId: "PN1" });
  });

  it("⭐ recusa SEM envelope (como a doc da Meta mostra) também é reconhecida", () => {
    const ev = parseMetaWebhook({
      messaging_product: "whatsapp",
      metadata: META,
      history: [{ errors: [{ code: 2593109 }] }],
    } as never);
    expect(ev).toEqual([expect.objectContaining({ kind: "history_declined", phoneNumberId: "PN1", code: 2593109 })]);
  });

  it("thread sem mensagens não vira conversa vazia", () => {
    const [e] = parseMetaWebhook(
      envelope("history", { history: [{ metadata: { phase: 0 }, threads: [{ id: "55", messages: [] }] }] }),
    );
    if (e?.kind !== "history_chunk") throw new Error("tipo");
    expect(e.threads).toEqual([]);
  });
});

describe("smb_app_state_sync — agenda do app", () => {
  it("add traz o nome; remove não", () => {
    const ev = parseMetaWebhook(
      envelope("smb_app_state_sync", {
        state_sync: [
          { type: "contact", contact: { full_name: "Maria Silva", first_name: "Maria", phone_number: "5584988887777" }, action: "add", metadata: { timestamp: "1" } },
          { type: "contact", contact: { phone_number: "5584977776666" }, action: "remove", metadata: { timestamp: "1" } },
          { type: "outra_coisa", contact: { phone_number: "1" }, action: "add" },
        ],
      }),
    );
    expect(ev).toEqual([
      expect.objectContaining({ kind: "contact_sync", action: "add", phone: "5584988887777", fullName: "Maria Silva" }),
      expect.objectContaining({ kind: "contact_sync", action: "remove", phone: "5584977776666", fullName: null }),
    ]);
  });
});

describe("campos que continuam como sempre", () => {
  it("inbound normal NÃO é capturado pelos parsers novos", () => {
    const ev = parseMetaWebhook(
      envelope("messages", {
        contacts: [{ wa_id: "5584988887777", profile: { name: "Ana" } }],
        messages: [{ from: "5584988887777", id: "wamid.I", timestamp: "1700000000", type: "text", text: { body: "oi" } }],
      }),
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("inbound_message");
  });

  it("campo desconhecido é ignorado, não erro", () => {
    expect(parseMetaWebhook(envelope("campo_novo_da_meta", { x: 1 }))).toEqual([]);
  });
});
