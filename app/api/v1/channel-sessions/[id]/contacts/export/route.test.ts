/**
 * A rota de exportação decide QUAL fonte ler e COMO recusar — é aí que mora o risco:
 * baixar a agenda do canal errado, recusar sem dizer o que fazer, ou gravar dado
 * pessoal na auditoria.
 *
 * O dublê do banco aplica os filtros de verdade: um `maybeSingle` fixo deixaria
 * "canal de outra organização → 404" passar mesmo sem o `eq("organization_id")`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { AgendaGrandeDemaisError, AgendaIndisponivelError } from "@/lib/channels/agenda";
import { getAdapter } from "@/lib/channels";
import { contatosDoCanal } from "@/lib/contacts/contatos-do-canal";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/contacts/contatos-do-canal", async (orig) => ({
  ...(await orig<typeof import("@/lib/contacts/contatos-do-canal")>()),
  contatosDoCanal: vi.fn(),
}));
// O provedor é detalhe do adapter: a rota só pede o ref da sessão e o adapter.
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: vi.fn(),
  resolveSessionRef: vi.fn(() => "ref-da-sessao"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";

const linhaDoCanal = {
  id: CANAL,
  organization_id: ORG,
  display_name: "Ads Company",
  phone_number: "+5584999990000",
  provider: "qualquer",
};

function banco(linhas: Array<Record<string, unknown>> = [linhaDoCanal]) {
  const filtros: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filtros.push([col, val]);
      return builder;
    },
    maybeSingle: async () => ({
      data: linhas.find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null,
    }),
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => builder } as never);
  return filtros;
}

function adapterCom(listAddressBook?: (...a: never[]) => Promise<unknown>, configurado = true) {
  vi.mocked(getAdapter).mockReturnValue({
    provider: "qualquer",
    isConfigured: () => configurado,
    ...(listAddressBook ? { listAddressBook } : {}),
  } as never);
}

const pedir = (fonte?: string, id = CANAL) =>
  GET(
    new NextRequest(
      `http://x/api/v1/channel-sessions/${id}/contacts/export${fonte ? `?fonte=${fonte}` : ""}`,
    ),
    { params: Promise.resolve({ id }) },
  );

const agendaDe = (n: number) => ({
  linhas: Array.from({ length: n }, (_, i) => ({
    nome: `Pessoa ${i}`,
    telefone: `+55819999900${String(i).padStart(2, "0")}`,
    salvo: i % 2 === 0,
    nome_no_whatsapp: null,
  })),
  sem_telefone: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER },
    org: { orgId: ORG },
  } as never);
  banco();
});

describe("GET /channel-sessions/[id]/contacts/export", () => {
  it("sem permissão devolve a resposta do guard e não toca no banco nem no canal", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("no", { status: 403 }),
    } as never);
    expect((await pedir()).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("id que não é uuid → 422; fonte desconhecida → 422", async () => {
    expect((await pedir(undefined, "nao-e-uuid")).status).toBe(422);
    expect((await pedir("tudo")).status).toBe(422);
  });

  it("⭐ canal de OUTRA organização → 404 (o filtro de organização está na consulta)", async () => {
    const filtros = banco([{ ...linhaDoCanal, organization_id: OUTRA_ORG }]);
    adapterCom(async () => agendaDe(1));
    expect((await pedir()).status).toBe(404);
    expect(filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).not.toHaveBeenCalled();
  });

  describe("fonte=agenda (padrão)", () => {
    it("⭐ baixa a agenda do canal e audita SÓ contagens — nunca nome nem telefone", async () => {
      const listAddressBook = vi.fn(async () => agendaDe(4));
      adapterCom(listAddressBook as never);
      const res = await pedir();
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/csv");
      expect(res.headers.get("Content-Disposition")).toMatch(/agenda-ads-company-\d{4}-\d{2}-\d{2}\.csv/);
      const csv = await res.text();
      expect(csv).toContain("nome,telefone,salvo_na_agenda,nome_no_whatsapp");
      expect(csv.trim().split("\r\n")).toHaveLength(5);
      expect(listAddressBook).toHaveBeenCalledWith({ sessionRef: "ref-da-sessao" });
      expect(contatosDoCanal).not.toHaveBeenCalled();
      // A tela usa estes dois para avisar quantas pessoas ficaram de fora.
      expect(res.headers.get("X-Contatos-Exportados")).toBe("4");
      expect(res.headers.get("X-Contatos-Sem-Numero")).toBe("3");

      expect(audit).toHaveBeenCalledTimes(1);
      const evento = vi.mocked(audit).mock.calls[0]![0];
      expect(evento).toMatchObject({
        action: "contacts.exported",
        organizationId: ORG,
        resourceId: CANAL,
        metadata: { fonte: "agenda", contatos: 4, salvos: 2, nao_salvos: 2, sem_telefone: 3 },
      });
      expect(JSON.stringify(evento)).not.toMatch(/Pessoa|\+5581/);
    });

    it("⭐ canal que não guarda agenda → 422 com saída, e nada é auditado como exportado", async () => {
      adapterCom(undefined);
      const res = await pedir();
      expect(res.status).toBe(422);
      const corpo = await res.json();
      expect(corpo.error.code).toBe("channel_without_address_book");
      expect(corpo.error.message).toMatch(/Importar/);
      expect(audit).not.toHaveBeenCalled();
    });

    it("serviço de WhatsApp fora do ar neste ambiente → 503", async () => {
      adapterCom(async () => agendaDe(1), false);
      expect((await pedir()).status).toBe(503);
    });

    it("⭐ número sem agenda guardada → 409 com código estável para a tela abrir o re-pareamento", async () => {
      adapterCom(async () => {
        throw new AgendaIndisponivelError("armazenamento_desligado");
      });
      const res = await pedir();
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("address_book_unavailable");
      expect(audit).not.toHaveBeenCalled();
    });

    it("agenda vazia (recém-pareado) → 409 'ainda não sincronizou', não um CSV só com cabeçalho", async () => {
      adapterCom(async () => ({ linhas: [], sem_telefone: 0 }));
      const res = await pedir();
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("address_book_not_ready");
      expect(audit).not.toHaveBeenCalled();
    });

    it("lista grande demais → 413", async () => {
      adapterCom(async () => {
        throw new AgendaGrandeDemaisError();
      });
      expect((await pedir()).status).toBe(413);
    });

    it("⭐ falha do canal → 502 genérico, sem vazar o erro interno", async () => {
      adapterCom(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:3000 token=segredo");
      });
      const res = await pedir();
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toMatch(/ECONNREFUSED|segredo|10\.0\.0\.5/);
    });
  });

  describe("fonte=conversas", () => {
    it("⭐ usa só o CRM e NÃO consulta o canal — funciona em número antigo e no canal oficial", async () => {
      vi.mocked(contatosDoCanal).mockResolvedValue([
        {
          contato: {
            name: "Ana",
            display_name: null,
            phone_number: "+5581999990001",
            email: null,
            tags: null,
            source: null,
            is_blocked: false,
            consent: {},
            created_at: null,
          },
          primeira_conversa_em: null,
          ultima_mensagem_em: null,
        },
      ]);
      const res = await pedir("conversas");
      expect(res.status).toBe(200);
      expect(getAdapter).not.toHaveBeenCalled();
      expect(res.headers.get("Content-Disposition")).toMatch(/contatos-ads-company-/);
      expect(vi.mocked(contatosDoCanal)).toHaveBeenCalledWith(expect.anything(), ORG, CANAL);
      expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
        metadata: { fonte: "conversas", contatos: 1 },
      });
    });
  });
});
