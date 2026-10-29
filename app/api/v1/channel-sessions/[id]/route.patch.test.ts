/**
 * PATCH /api/v1/channel-sessions/[id] — renomear o número e escolher o funil de entrada.
 *
 * O dublê aplica os filtros `eq` de verdade: um canal ou funil de OUTRA organização
 * só "não aparece" se a rota filtrar `organization_id` — com um stub que devolve a
 * linha sempre, apagar esse filtro deixaria os testes verdes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const FUNIL = "55555555-5555-4555-8555-555555555555";
const FUNIL_ALHEIO = "66666666-6666-4666-8666-666666666666";
const FUNIL_ARQUIVADO = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;

function montarDb() {
  const tabelas: Record<string, Linha[]> = {
    channel_sessions: [
      { id: CANAL, organization_id: ORG, display_name: "Comercial", entry_pipeline_id: null },
    ],
    crm_pipelines: [
      { id: FUNIL, organization_id: ORG, is_archived: false },
      { id: FUNIL_ALHEIO, organization_id: OUTRA_ORG, is_archived: false },
      { id: FUNIL_ARQUIVADO, organization_id: ORG, is_archived: true },
    ],
  };
  const escritas: Array<{ table: string; patch: Linha; filtros: Array<[string, unknown]> }> = [];

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private patch: Linha | null = null;
    constructor(private readonly table: string) {}
    select(): this {
      return this;
    }
    update(p: Linha): this {
      this.patch = p;
      return this;
    }
    eq(c: string, v: unknown): this {
      this.filtros.push([c, v]);
      return this;
    }
    private achar(): Linha | null {
      return (
        (tabelas[this.table] ?? []).find((l) => this.filtros.every(([c, v]) => l[c] === v)) ?? null
      );
    }
    private resolver(): { data: Linha | null; error: null } {
      const linha = this.achar();
      // Devolve CÓPIA: o banco real entrega linhas independentes, e devolver a
      // mesma referência faria o "antes" da auditoria mudar junto com o "depois".
      const antes = linha ? { ...linha } : null;
      if (this.patch) {
        escritas.push({ table: this.table, patch: this.patch, filtros: this.filtros });
        if (linha) Object.assign(linha, this.patch);
        return { data: linha ? { ...linha } : null, error: null };
      }
      return { data: antes, error: null };
    }
    maybeSingle() {
      return Promise.resolve(this.resolver());
    }
    single() {
      return Promise.resolve(this.resolver());
    }
    then<R1 = unknown, R2 = never>(
      res?: ((v: unknown) => R1 | PromiseLike<R1>) | null,
      rej?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.resolver()).then(res, rej);
    }
  }

  vi.mocked(createClient).mockResolvedValue({ from: (t: string) => new Q(t) } as never);
  return { tabelas, escritas };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = (id = CANAL) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER },
    org: { orgId: ORG },
  } as never);
});

describe("PATCH /channel-sessions/[id]", () => {
  it("⭐ renomeia: grava o nome aparado, filtrando pela organização, e audita o antes/depois", async () => {
    const { escritas, tabelas } = montarDb();
    const res = await PATCH(req({ display_name: "  Estética  " }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.channel_sessions![0]!.display_name).toBe("Estética");
    expect(escritas[0]!.filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.settings_changed",
        metadata: expect.objectContaining({
          display_name: { de: "Comercial", para: "Estética" },
        }),
      }),
    );
  });

  it("nome em branco limpa o apelido (a tela volta a mostrar o número)", async () => {
    const { tabelas } = montarDb();
    const res = await PATCH(req({ display_name: "   " }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.channel_sessions![0]!.display_name).toBeNull();
  });

  it("⭐ define o funil de entrada com um funil ativo da organização", async () => {
    const { tabelas } = montarDb();
    const res = await PATCH(req({ entry_pipeline_id: FUNIL }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.channel_sessions![0]!.entry_pipeline_id).toBe(FUNIL);
  });

  it("⭐ funil de OUTRA organização é recusado e nada é gravado", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ entry_pipeline_id: FUNIL_ALHEIO }), ctx());
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("funil arquivado é recusado", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ entry_pipeline_id: FUNIL_ARQUIVADO }), ctx());
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("null volta ao funil padrão", async () => {
    const { tabelas } = montarDb();
    tabelas.channel_sessions![0]!.entry_pipeline_id = FUNIL;
    const res = await PATCH(req({ entry_pipeline_id: null }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.channel_sessions![0]!.entry_pipeline_id).toBeNull();
  });

  it("canal de outra organização → 404, sem escrita", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ display_name: "x" }), ctx("88888888-8888-4888-8888-888888888888"));
    expect(res.status).toBe(404);
    expect(escritas).toHaveLength(0);
  });

  it("corpo vazio, campo desconhecido ou funil que não é uuid → 422", async () => {
    montarDb();
    expect((await PATCH(req({}), ctx())).status).toBe(422);
    expect((await PATCH(req({ status: "STOPPED" }), ctx())).status).toBe(422);
    expect((await PATCH(req({ entry_pipeline_id: "nao-e-uuid" }), ctx())).status).toBe(422);
  });

  it("sem permissão de admin, devolve a resposta de recusa e não toca no banco", async () => {
    const { escritas } = montarDb();
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await PATCH(req({ display_name: "x" }), ctx());
    expect(res.status).toBe(403);
    expect(escritas).toHaveLength(0);
  });
});
