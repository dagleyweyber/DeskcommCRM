/**
 * GET /api/v1/conversations/counts — os badges das abas do inbox.
 *
 * O defeito que esta suíte guarda: com um número selecionado, a lista filtrava e os
 * badges não ("Todas 987" sobre uma lista de 152). O dublê registra os filtros de
 * chamada — sem isso, passar `channel_session_id` na URL e esquecê-lo na
 * consulta seria indistinguível de funcionar. Desde a 0208 as três contagens são
 * uma só chamada (fn_conversation_counts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";

let chamadas: Array<{ fn: string; args: Record<string, unknown> }>;
let resposta: { data: unknown; error: { message: string } | null };

beforeEach(() => {
  chamadas = [];
  resposta = { data: [{ unassigned: 3, mine: "5", total: 7 }], error: null };
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USER } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return resposta;
    },
  } as never);
});

const chamar = (qs = "") => GET(new Request("http://localhost/api/v1/conversations/counts" + qs));

describe("GET /conversations/counts", () => {
  it("⭐ com número selecionado, a contagem filtra por ele e pela organização ativa", async () => {
    const res = await chamar("?channel_session_id=" + CANAL);
    expect(res.status).toBe(200);
    expect(chamadas).toHaveLength(1); // uma leitura, não três
    expect(chamadas[0]).toMatchObject({
      fn: "fn_conversation_counts",
      args: { p_org: ORG, p_channel_session_id: CANAL },
    });
  });

  it("sem número, conta a organização inteira (nenhum filtro de canal)", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(chamadas[0]?.args.p_channel_session_id).toBeNull();
  });

  it("⭐ os estados terminais vêm da constante da aba, não de uma lista copiada", async () => {
    await chamar();
    expect(chamadas[0]?.args.p_terminal_statuses).toEqual([...CONVERSATION_TERMINAL_STATUSES]);
  });

  it("devolve as três contagens no contrato de sempre (aceita bigint como texto)", async () => {
    const body = await (await chamar()).json();
    expect(body.data).toEqual({ unassigned: 3, mine: 5, all: 7 });
  });

  it("resposta vazia vira zeros, não erro", async () => {
    resposta = { data: [], error: null };
    const body = await (await chamar()).json();
    expect(body.data).toEqual({ unassigned: 0, mine: 0, all: 0 });
  });

  it("erro do banco → 500", async () => {
    resposta = { data: null, error: { message: "boom" } };
    expect((await chamar()).status).toBe(500);
  });

  it("channel_session_id que não é uuid → 422, sem consultar o banco", async () => {
    const res = await chamar("?channel_session_id=abc");
    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });
});
