/**
 * GET /api/v1/conversations/counts — os badges das abas do inbox.
 *
 * O defeito que esta suíte guarda: com um número selecionado, a lista filtrava e os
 * badges não ("Todas 987" sobre uma lista de 152). O dublê registra os filtros de
 * CADA contagem — sem isso, passar `channel_session_id` na URL e esquecê-lo na
 * consulta seria indistinguível de funcionar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";

let consultas: Array<Array<[string, unknown]>>;

beforeEach(() => {
  consultas = [];
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USER } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG } as never);

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    constructor() {
      consultas.push(this.filtros);
    }
    select(): this {
      return this;
    }
    eq(c: string, v: unknown): this {
      this.filtros.push([c, v]);
      return this;
    }
    is(c: string, v: unknown): this {
      this.filtros.push([c, v]);
      return this;
    }
    not(c: string, _op: string, v: unknown): this {
      this.filtros.push([c, v]);
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(res: any, rej: any) {
      return Promise.resolve({ count: 7, error: null }).then(res, rej);
    }
  }
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: () => new Q(),
  } as never);
});

const chamar = (qs = "") => GET(new Request(`http://localhost/api/v1/conversations/counts${qs}`));

describe("GET /conversations/counts", () => {
  it("⭐ com número selecionado, as TRÊS contagens filtram por ele", async () => {
    const res = await chamar(`?channel_session_id=${CANAL}`);
    expect(res.status).toBe(200);
    expect(consultas).toHaveLength(3);
    for (const filtros of consultas) {
      expect(filtros).toContainEqual(["channel_session_id", CANAL]);
      expect(filtros).toContainEqual(["organization_id", ORG]);
    }
  });

  it("sem número, conta a organização inteira (nenhuma contagem filtra por canal)", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    for (const filtros of consultas) {
      expect(filtros.some(([c]) => c === "channel_session_id")).toBe(false);
    }
  });

  it("channel_session_id que não é uuid → 422, sem consultar o banco", async () => {
    const res = await chamar("?channel_session_id=abc");
    expect(res.status).toBe(422);
    expect(consultas).toHaveLength(0);
  });
});
