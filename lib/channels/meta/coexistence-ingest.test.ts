import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EchoEvent, HistoryChunkEvent } from "./coexistence-webhook";

/**
 * O que estes testes protegem é a REGRA do arquivo, não o encanamento: eco, histórico
 * e agenda NUNCA passam por `pos-entrada` (que acorda o agente e cria lead), eco NÃO
 * move `last_inbound_at`, e o histórico leva a marca que a migration 0196 lê.
 */
const posEntrada = vi.fn();
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a) }));

const sessao = { id: "sess-1", organization_id: "org-1" };
let contatoExistente: { id: string; phone_number: string } | null = null;
vi.mock("./ingest", () => ({
  sessionByPhoneNumberId: async (_a: unknown, pn: string) => (pn === "PN1" ? sessao : null),
  findContactByVariants: async () => contatoExistente,
}));

import {
  ORIGEM_HISTORICO,
  ingestContactSync,
  ingestEcho,
  ingestHistoryChunk,
} from "./coexistence-ingest";

type Chamada = { tabela: string; op: string; arg?: unknown };

function fakeAdmin(opts: { jaExistem?: string[]; erroInsert?: { code: string; message: string } } = {}) {
  const chamadas: Chamada[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
      if (nome === "fn_upsert_wa_conversation" || nome === "fn_upsert_wa_conversation_historica") {
        return { data: "conv-1", error: null };
      }
      if (nome === "fn_reabrir_conversa_importada") return { data: false, error: null };
      return { data: null, error: null };
    },
    from: (tabela: string) => ({
      insert: (arg: unknown) => {
        chamadas.push({ tabela, op: "insert", arg });
        const resultado = { data: { id: "msg-1" }, error: opts.erroInsert ?? null };
        const p = Promise.resolve({ data: null, error: opts.erroInsert ?? null });
        return Object.assign(p, { select: () => ({ maybeSingle: async () => resultado }) });
      },
      select: () => ({
        eq: () => ({
          in: async () => ({
            data: (opts.jaExistem ?? []).map((external_id) => ({ external_id })),
            error: null,
          }),
        }),
      }),
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

const eco: EchoEvent = {
  kind: "echo",
  wabaId: "W1",
  phoneNumberId: "PN1",
  externalId: "wamid.E1",
  to: "5584988887777",
  toUserId: null,
  sentAt: new Date("2026-10-23T12:00:00Z"),
  type: "text",
  text: "oi",
  media: null,
};

beforeEach(() => {
  posEntrada.mockClear();
  contatoExistente = null;
});

describe("ingestEcho", () => {
  it("grava SAÍDA external_device, marca a conversa como outbound e NÃO aciona pos-entrada", async () => {
    const { admin, chamadas, rpcs } = fakeAdmin();
    const r = await ingestEcho(admin, eco);

    expect(r).toEqual({ status: "ingested", messageId: "msg-1" });
    const ins = chamadas.find((c) => c.tabela === "messages" && c.op === "insert")!.arg as Record<string, unknown>;
    expect(ins).toMatchObject({
      direction: "outbound",
      sent_via: "external_device",
      status: "sent",
      external_id: "wamid.E1",
      organization_id: "org-1",
      body: "oi",
    });
    const marca = rpcs.find((x) => x.nome === "fn_mark_conversation_message")!;
    // ⭐ outbound: é o que impede o eco de renovar a janela de 24h do cliente.
    expect(marca.args.p_direction).toBe("outbound");
    expect(posEntrada).not.toHaveBeenCalled();
  });

  it("⭐ a clínica respondeu pelo celular numa conversa do histórico: tenta reabri-la (e antes de carimbar)", async () => {
    const { admin, rpcs } = fakeAdmin();
    await ingestEcho(admin, eco);
    const nomes = rpcs.map((x) => x.nome);
    expect(nomes).toContain("fn_reabrir_conversa_importada");
    expect(nomes.indexOf("fn_reabrir_conversa_importada")).toBeLessThan(
      nomes.indexOf("fn_mark_conversation_message"),
    );
  });

  it("o eco de mensagem que o próprio CRM mandou (mesmo wamid) é duplicata, não erro", async () => {
    const { admin } = fakeAdmin({ erroInsert: { code: "23505", message: "dup" } });
    expect(await ingestEcho(admin, eco)).toEqual({ status: "duplicate" });
  });

  it("número que não é de nenhuma sessão nossa → no_session, nada gravado", async () => {
    const { admin, chamadas } = fakeAdmin();
    expect(await ingestEcho(admin, { ...eco, phoneNumberId: "OUTRO" })).toEqual({ status: "no_session" });
    expect(chamadas).toEqual([]);
  });
});

const chunk = (msgs: Array<[string, boolean]>): HistoryChunkEvent => ({
  kind: "history_chunk",
  wabaId: "W1",
  phoneNumberId: "PN1",
  phase: 1,
  chunkOrder: 0,
  progress: 10,
  threads: [
    {
      contactPhone: "5584988887777",
      contactUserId: null,
      messages: msgs.map(([id, inbound], i) => ({
        externalId: id,
        inbound,
        sentAt: new Date(1700000000000 + i * 1000),
        type: "text",
        text: `t-${id}`,
        media: null,
        status: "READ",
      })),
    },
  ],
});

describe("ingestHistoryChunk", () => {
  it("⭐ toda linha leva a marca que a migration 0196 usa para NÃO emitir evento", async () => {
    const { admin, chamadas } = fakeAdmin();
    const r = await ingestHistoryChunk(admin, chunk([["a", true], ["b", false]]));

    expect(r).toEqual({ status: "imported", inserted: 2, skipped: 0, threads: 1 });
    const linhas = chamadas.find((c) => c.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    expect(linhas).toHaveLength(2);
    for (const l of linhas) {
      expect((l.metadata as Record<string, unknown>).origem).toBe(ORIGEM_HISTORICO);
      expect(l.sent_via).toBe("external_device");
    }
    expect(linhas.map((l) => l.direction)).toEqual(["inbound", "outbound"]);
  });

  it("⭐ cria a conversa pela função HISTÓRICA (fechada e marcada) — nunca pela comum, que a deixaria aberta e roteada", async () => {
    const { admin, rpcs } = fakeAdmin();
    await ingestHistoryChunk(admin, chunk([["a", true]]));
    const nomes = rpcs.map((x) => x.nome);
    expect(nomes).toContain("fn_upsert_wa_conversation_historica");
    expect(nomes).not.toContain("fn_upsert_wa_conversation");
  });

  it("mensagem antiga com ERRO de envio entra como enviada — não polui as falhas recentes do painel de saúde", async () => {
    const { admin, chamadas } = fakeAdmin();
    const c = chunk([["a", false]]);
    c.threads[0]!.messages[0] = { ...c.threads[0]!.messages[0]!, status: "ERROR" };
    await ingestHistoryChunk(admin, c);
    const [linha] = chamadas.find((x) => x.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    expect(linha!.status).toBe("sent");
    expect((linha!.metadata as Record<string, unknown>).status_original).toBe("ERROR");
  });

  it("não aciona pos-entrada e não mexe em janela/não-lidas (nada de fn_mark_conversation_message)", async () => {
    const { admin, rpcs } = fakeAdmin();
    await ingestHistoryChunk(admin, chunk([["a", true]]));
    expect(posEntrada).not.toHaveBeenCalled();
    expect(rpcs.some((x) => x.nome === "fn_mark_conversation_message")).toBe(false);
  });

  it("reentrega: o que já existe por external_id é pulado, só o novo entra", async () => {
    const { admin, chamadas } = fakeAdmin({ jaExistem: ["a"] });
    const r = await ingestHistoryChunk(admin, chunk([["a", true], ["b", true]]));
    expect(r).toEqual({ status: "imported", inserted: 1, skipped: 1, threads: 1 });
    const linhas = chamadas.find((c) => c.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    expect(linhas.map((l) => l.external_id)).toEqual(["b"]);
  });

  it("mídia anterior não é baixada: entra como texto com marcador honesto", async () => {
    const { admin, chamadas } = fakeAdmin();
    const c = chunk([["a", true]]);
    c.threads[0]!.messages[0] = { ...c.threads[0]!.messages[0]!, type: "image", text: null };
    await ingestHistoryChunk(admin, c);
    const [linha] = chamadas.find((x) => x.tabela === "messages")!.arg as Array<Record<string, unknown>>;
    expect(linha).toMatchObject({ type: "text" });
    expect(String(linha!.body)).toContain("anterior à conexão");
  });
});

describe("ingestContactSync", () => {
  const ev = {
    kind: "contact_sync",
    wabaId: "W1",
    phoneNumberId: "PN1",
    action: "add",
    phone: "5584988887777",
    fullName: "Maria",
  } as const;

  it("⭐ contato desconhecido NÃO é criado — a agenda do celular é pessoal", async () => {
    contatoExistente = null;
    const { admin, rpcs, chamadas } = fakeAdmin();
    expect(await ingestContactSync(admin, ev)).toBe("skipped");
    expect(rpcs).toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it("contato conhecido sem nome ganha o nome; `remove` nunca apaga nada", async () => {
    contatoExistente = { id: "c1", phone_number: "+5584988887777" };
    const { admin, chamadas } = fakeAdmin();
    expect(await ingestContactSync(admin, ev)).toBe("enriched");
    expect(chamadas[0]).toMatchObject({ tabela: "contacts", op: "update", arg: { name: "Maria" } });
    expect(await ingestContactSync(admin, { ...ev, action: "remove" })).toBe("skipped");
  });
});
