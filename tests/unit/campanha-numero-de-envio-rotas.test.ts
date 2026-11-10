import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As duas rotas por trás de "por qual número vai sair?":
 *
 *   - GET /channels/templates?channel_session_id=: a lista de modelos é a de UM número. Sem isso,
 *     organização com dois números via os modelos dos dois misturados e repetidos;
 *   - POST /campaigns: recusa canal que não é da API oficial (um canal por QR passava na
 *     checagem e a campanha nascia para nunca enviar).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NUMERO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NUMERO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u1" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "admin" }),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, org: { orgId: ORG }, user: { id: "u1" } }),
}));
const metaSessionForOrg = vi.fn(async () => ({ id: NUMERO_A, wabaId: "WA" }));
vi.mock("@/lib/channels/meta/session", () => ({ metaSessionForOrg: () => metaSessionForOrg() }));

/** Registra cada consulta (tabela + filtros) e devolve o que o cenário definiu para a tabela. */
const consultas: Array<{ tabela: string; filtros: unknown[][] }> = [];
let linhas: Record<string, unknown> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const registro = { tabela, filtros: [] as unknown[][] };
      consultas.push(registro);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order"]) {
        q[m] = (...a: unknown[]) => {
          registro.filtros.push([m, ...a]);
          return q;
        };
      }
      q.maybeSingle = async () => ({ data: linhas[tabela] ?? null, error: null });
      q.then = (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela] ?? [], error: null });
      return q;
    },
  }),
}));

import { POST as criarCampanha } from "@/app/api/v1/campaigns/route";
import { GET as listarModelos } from "@/app/api/v1/channels/templates/route";

const get = (qs = "") => listarModelos(new NextRequest(`http://x/api/v1/channels/templates${qs}`));

beforeEach(() => {
  consultas.length = 0;
  linhas = {};
  metaSessionForOrg.mockClear();
});

describe("GET /channels/templates — modelos de UM número", () => {
  it("⭐ com o número escolhido, filtra os modelos por ele e devolve a sessão dele", async () => {
    linhas = { channel_sessions: { id: NUMERO_B, meta_waba_id: "WB" }, meta_templates: [] };
    const res = await get(`?channel_session_id=${NUMERO_B}`);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.channelSessionId).toBe(NUMERO_B);
    expect(corpo.data.waba).toBe("WB");
    const modelos = consultas.find((c) => c.tabela === "meta_templates")!;
    expect(modelos.filtros).toContainEqual(["eq", "channel_session_id", NUMERO_B]);
    expect(modelos.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(metaSessionForOrg).not.toHaveBeenCalled();
  });

  it("⭐ o número tem que ser DESTA organização e da API oficial", async () => {
    linhas = { channel_sessions: { id: NUMERO_B, meta_waba_id: "WB" } };
    await get(`?channel_session_id=${NUMERO_B}`);
    const sessao = consultas.find((c) => c.tabela === "channel_sessions")!;
    expect(sessao.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(sessao.filtros).toContainEqual(["eq", "provider", "meta_cloud"]);
    expect(sessao.filtros).toContainEqual(["is", "archived_at", null]);
  });

  it("número de outra organização (ou inexistente) é 404, não a lista de outro", async () => {
    linhas = { channel_sessions: null };
    const res = await get(`?channel_session_id=${NUMERO_B}`);
    expect(res.status).toBe(404);
    expect(consultas.some((c) => c.tabela === "meta_templates")).toBe(false);
  });

  it("id que não é UUID é 422", async () => {
    expect((await get("?channel_session_id=abc")).status).toBe(422);
  });

  it("⭐ sem o parâmetro, é o comportamento de sempre (primeiro número, sem filtro) — Conexões depende dele", async () => {
    linhas = { meta_templates: [] };
    const res = await get();
    const corpo = await res.json();
    expect(corpo.data.channelSessionId).toBe(NUMERO_A);
    expect(metaSessionForOrg).toHaveBeenCalledTimes(1);
    const modelos = consultas.find((c) => c.tabela === "meta_templates")!;
    expect(modelos.filtros.some((f) => f[1] === "channel_session_id")).toBe(false);
  });
});

describe("POST /campaigns — só por número da API oficial", () => {
  const corpo = {
    name: "Teste",
    channel_session_id: NUMERO_A,
    template_name: "oferta",
    template_language: "pt_BR",
    audience: { kind: "all_contacts" },
  };
  const post = () =>
    criarCampanha(
      new NextRequest("http://x/api/v1/campaigns", { method: "POST", body: JSON.stringify(corpo) }),
    );

  it("⭐ canal de outro tipo (QR code) é recusado antes de qualquer coisa", async () => {
    linhas = { channel_sessions: { id: NUMERO_A, status: "WORKING", provider: "waha" } };
    const res = await post();
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("API oficial");
    expect(consultas.some((c) => c.tabela === "meta_templates")).toBe(false);
  });

  it("canal oficial segue para a conferência do modelo", async () => {
    linhas = { channel_sessions: { id: NUMERO_A, status: "WORKING", provider: "meta_cloud" }, meta_templates: null };
    const res = await post();
    // Sem modelo aprovado neste número a rota recusa DEPOIS da checagem do canal.
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("não está aprovado");
  });
});
