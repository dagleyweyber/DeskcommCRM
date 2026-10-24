import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoryChunkEvent, HistoryMediaEvent } from "./coexistence-webhook";
import { parseMetaWebhook } from "./webhook";

/**
 * Mídia do histórico. Medido na primeira coexistência real: ~125 entregas `history` SEM
 * `threads`, só com `messages[]`/`message_echoes[]` carregando a mídia, que o CRM
 * descartava. Só 1 de 24 amostras tinha um marcador correspondente no banco — as demais
 * eram a PRÓPRIA mensagem, que o bloco principal nunca trouxe.
 */
const posEntrada = vi.fn();
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a) }));

const sessao = { id: "sess-1", organization_id: "org-1" };
vi.mock("./ingest", () => ({
  sessionByPhoneNumberId: async (_a: unknown, pn: string) => (pn === "PN1" ? sessao : null),
  findContactByVariants: async () => null,
  resolverContatoMeta: async () => ({ id: "contact-1" }),
}));

import { ingestHistoryChunk, ingestHistoryMedia } from "./coexistence-ingest";

const META = { display_phone_number: "5581995191160", phone_number_id: "PN1" };
const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W1", changes: [{ field: "history", value: { messaging_product: "whatsapp", metadata: META, ...value } }] }],
});

describe("parser — mídia do histórico", () => {
  it("⭐ sticker do CONTATO (`messages[]`): inbound, com o BSUID e a mídia", () => {
    const [e] = parseMetaWebhook(
      envelope({
        messages: [
          { from: "5581999990000", from_user_id: "BR.1", id: "wamid.M1", timestamp: "1700000000", type: "sticker",
            sticker: { id: "MID1", mime_type: "image/webp", animated: false, sha256: "x", url: "https://x" } },
        ],
      }),
    );
    expect(e).toMatchObject({
      kind: "history_media", externalId: "wamid.M1", inbound: true, phone: "5581999990000",
      userId: "BR.1", type: "sticker", media: { id: "MID1", mime: "image/webp" },
    });
  });

  it("⭐ mídia NOSSA (`message_echoes[]`): outbound, e o contato é o `to`", () => {
    const [e] = parseMetaWebhook(
      envelope({
        message_echoes: [
          { from: "5581995191160", to: "5581999990000", to_user_id: "BR.2", id: "wamid.M2", timestamp: "1700000000",
            type: "audio", audio: { id: "MID2", mime_type: "audio/ogg", voice: true } },
        ],
      }),
    );
    expect(e).toMatchObject({
      kind: "history_media", inbound: false, phone: "5581999990000", userId: "BR.2",
      type: "audio", media: { id: "MID2", voice: true },
    });
  });

  it("legenda de imagem vira o texto da mensagem", () => {
    const [e] = parseMetaWebhook(
      envelope({
        messages: [{ from: "5581999990000", id: "wamid.M3", timestamp: "1", type: "image", image: { id: "MID3", mime_type: "image/jpeg", caption: "olha" } }],
      }),
    );
    expect(e).toMatchObject({ type: "image", text: "olha" });
  });

  it("só BSUID (telefone omitido) ainda é aceito", () => {
    const [e] = parseMetaWebhook(
      envelope({ message_echoes: [{ to_user_id: "BR.9", id: "wamid.M4", timestamp: "1", type: "sticker", sticker: { id: "MID4" } }] }),
    );
    expect(e).toMatchObject({ kind: "history_media", phone: null, userId: "BR.9" });
  });

  it("sem NENHUM identificador do contato, ou sem mídia, ou texto puro: ignorado", () => {
    expect(parseMetaWebhook(envelope({ messages: [{ id: "a", timestamp: "1", type: "sticker", sticker: { id: "x" } }] }))).toEqual([]);
    expect(parseMetaWebhook(envelope({ messages: [{ from: "55", id: "b", timestamp: "1", type: "sticker" }] }))).toEqual([]);
    expect(parseMetaWebhook(envelope({ messages: [{ from: "55", id: "c", timestamp: "1", type: "text", text: { body: "x" } }] }))).toEqual([]);
  });

  it("o bloco principal (`history[].threads`) NÃO é confundido com mídia solta", () => {
    const ev = parseMetaWebhook(
      envelope({ history: [{ metadata: { phase: 0, chunk_order: 0, progress: 100 }, threads: [] }] }),
    );
    expect(ev.map((e) => e.kind)).toEqual(["history_chunk"]);
  });

  it("⭐ eco de STICKER enviado pelo celular vira mensagem (antes era descartado)", () => {
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: "W1", changes: [{ field: "smb_message_echoes", value: { metadata: META, message_echoes: [
        { from: "x", to: "5581999990000", id: "wamid.S1", timestamp: "1", type: "sticker", sticker: { id: "MS1", mime_type: "image/webp" } },
      ] } }] }],
    });
    expect(e).toMatchObject({ kind: "echo", type: "sticker", media: { id: "MS1" } });
  });
});

type Chamada = { tabela: string; op: string; arg?: unknown };

function fakeAdmin(existente: { id: string; conversation_id: string; metadata: Record<string, unknown> } | null = null, erroInsert?: { code: string; message: string }) {
  const chamadas: Chamada[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome === "fn_upsert_wa_conversation_historica") return { data: "conv-1", error: null };
      return { data: null, error: null };
    },
    from: (tabela: string) => ({
      select: () => {
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        q.in = async () => ({ data: [], error: null });
        q.maybeSingle = async () => ({ data: existente, error: null });
        return q;
      },
      insert: (arg: unknown) => {
        chamadas.push({ tabela, op: "insert", arg });
        const resultado = { data: { id: "msg-novo" }, error: erroInsert ?? null };
        return Object.assign(Promise.resolve({ data: null, error: erroInsert ?? null }), {
          select: () => ({ maybeSingle: async () => resultado }),
        });
      },
      update: (arg: unknown) => {
        chamadas.push({ tabela, op: "update", arg });
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        q.is = () => q;
        q.or = async () => ({ error: null });
        return Object.assign(Promise.resolve({ error: null }), q);
      },
    }),
  };
  return { admin: admin as never, chamadas, rpcs };
}

const evento = (p: Partial<HistoryMediaEvent> = {}): HistoryMediaEvent => ({
  kind: "history_media", wabaId: "W1", phoneNumberId: "PN1", externalId: "wamid.M1", inbound: true,
  phone: "5581999990000", userId: null, sentAt: new Date("2026-10-01T10:00:00Z"), type: "sticker",
  text: null, media: { id: "MID1", mime: "image/webp" }, ...p,
});

beforeEach(() => posEntrada.mockClear());

describe("ingestHistoryMedia", () => {
  it("⭐ marcador existente: ATUALIZA com a mídia, troca o tipo, e pede o download", async () => {
    const { admin, chamadas, rpcs } = fakeAdmin({
      id: "msg-1", conversation_id: "conv-1",
      metadata: { origem: "historico_importado", tipo_original: "media_placeholder", fase: 0 },
    });
    expect(await ingestHistoryMedia(admin, evento())).toBe("atualizada");

    const up = chamadas.find((c) => c.op === "update")!.arg as Record<string, unknown>;
    expect(up).toMatchObject({ type: "sticker", media_url: "MID1", media_mime: "image/webp", body: null });
    // a marca do histórico SOBREVIVE (e com ela o gatilho segue sem emitir evento)
    expect(up.metadata).toMatchObject({ origem: "historico_importado", tipo_original: "sticker", meta_media_id: "MID1" });
    expect(rpcs.map((r) => r.nome)).toContain("emit_event");
    expect(chamadas.some((c) => c.op === "insert")).toBe(false);
  });

  it("⭐ sem marcador: CRIA a mensagem numa conversa HISTÓRICA (fechada), marcada, sem pos-entrada", async () => {
    const { admin, chamadas, rpcs } = fakeAdmin(null);
    expect(await ingestHistoryMedia(admin, evento({ inbound: false, type: "audio", media: { id: "MID2", mime: "audio/ogg", voice: true } }))).toBe("criada");

    expect(rpcs.map((r) => r.nome)).toContain("fn_upsert_wa_conversation_historica");
    expect(rpcs.map((r) => r.nome)).not.toContain("fn_upsert_wa_conversation");
    const linha = chamadas.find((c) => c.op === "insert")!.arg as Record<string, unknown>;
    expect(linha).toMatchObject({
      direction: "outbound", status: "sent", type: "audio", external_id: "wamid.M1",
      media_url: "MID2", sent_via: "external_device",
    });
    expect(linha.metadata).toMatchObject({ origem: "historico_importado", voice: true });
    expect(posEntrada).not.toHaveBeenCalled();
    expect(rpcs.map((r) => r.nome)).toContain("emit_event");
  });

  it("⭐ linha que NÃO é marcador (já tem conteúdo): duplicata — nunca sobrescreve", async () => {
    const { admin, chamadas } = fakeAdmin({ id: "msg-1", conversation_id: "conv-1", metadata: { origem: "historico_importado", tipo_original: "sticker" } });
    expect(await ingestHistoryMedia(admin, evento())).toBe("duplicada");
    expect(chamadas).toEqual([]);
  });

  it("corrida com o bloco principal (23505 no insert) é duplicata, não erro", async () => {
    const { admin } = fakeAdmin(null, { code: "23505", message: "dup" });
    expect(await ingestHistoryMedia(admin, evento())).toBe("duplicada");
  });

  it("número de outra sessão: no_session, nada gravado", async () => {
    const { admin, chamadas } = fakeAdmin(null);
    expect(await ingestHistoryMedia(admin, evento({ phoneNumberId: "OUTRO" }))).toBe("no_session");
    expect(chamadas).toEqual([]);
  });
});

const chunk = (messages: Array<{ id: string; type: string; text?: string | null }>): HistoryChunkEvent => ({
  kind: "history_chunk", wabaId: "W1", phoneNumberId: "PN1", phase: 0, chunkOrder: 0, progress: 100,
  threads: [{
    contactPhone: "5581999990000", contactUserId: null,
    messages: messages.map((m, i) => ({
      externalId: m.id, inbound: true, sentAt: new Date(1700000000000 + i * 1000),
      type: m.type, text: m.text ?? null, media: null, status: "READ",
    })),
  }],
});

describe("bloco principal — o que NÃO é mensagem", () => {
  it("⭐ `edit` e `revoke` não viram linha (antes entravam como \"mídia indisponível\")", async () => {
    const { admin, chamadas } = fakeAdmin();
    const r = await ingestHistoryChunk(admin, chunk([
      { id: "a", type: "text", text: "oi" },
      { id: "b", type: "edit" },
      { id: "c", type: "revoke" },
    ]));
    expect(r).toMatchObject({ status: "imported", inserted: 1, skipped: 2 });
    const linhas = chamadas.find((c) => c.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    expect(linhas.map((l) => l.external_id)).toEqual(["a"]);
  });

  it("thread só com `edit` não cria conversa nem contato", async () => {
    const { admin, chamadas, rpcs } = fakeAdmin();
    const r = await ingestHistoryChunk(admin, chunk([{ id: "b", type: "edit" }]));
    expect(r).toMatchObject({ status: "imported", inserted: 0, threads: 0 });
    expect(chamadas).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("`errors` tem texto próprio (não diz \"mídia\"); `media_placeholder` segue como mídia", async () => {
    const { admin, chamadas } = fakeAdmin();
    await ingestHistoryChunk(admin, chunk([{ id: "e", type: "errors" }, { id: "m", type: "media_placeholder" }]));
    const linhas = chamadas.find((c) => c.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    const porId = Object.fromEntries(linhas.map((l) => [l.external_id as string, String(l.body)]));
    expect(porId.e).toContain("não entrega");
    expect(porId.e).not.toContain("mídia");
    expect(porId.m).toContain("mídia anterior à conexão");
  });
});
