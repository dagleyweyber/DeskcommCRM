import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rate = vi.hoisted(() => vi.fn(async () => ({ allowed: true })));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: rate }));

interface Estado {
  fonte: { organization_id: string; is_active: boolean } | null;
  erroNoInsert?: { code?: string; message: string } | null;
  inseridos: Array<Record<string, unknown>>;
  consultasAFonte: unknown[];
}
const estado = vi.hoisted(() => ({ fonte: null, inseridos: [], consultasAFonte: [] }) as unknown as Estado);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "webhook_sources") {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = (_c: string, v: unknown) => (estado.consultasAFonte.push(v), q);
        q.maybeSingle = () => Promise.resolve({ data: estado.fonte, error: null });
        return q;
      }
      return {
        insert: (linha: Record<string, unknown>) => {
          estado.inseridos.push(linha);
          return Promise.resolve({ error: estado.erroNoInsert ?? null });
        },
      };
    },
  }),
}));

import { POST } from "./route";

const TOKEN = "tok_teste1234";

function req(corpo: string, opts: { tipo?: string; ip?: string } = {}): NextRequest {
  return new Request("https://crm.exemplo/api/v1/rastreio/clique/" + TOKEN, {
    method: "POST",
    headers: { "content-type": opts.tipo ?? "application/x-www-form-urlencoded", "x-forwarded-for": opts.ip ?? "203.0.113.7" },
    body: corpo,
  }) as unknown as NextRequest;
}
const chama = (r: NextRequest, token = TOKEN) => POST(r, { params: Promise.resolve({ token }) });

beforeEach(() => {
  estado.fonte = { organization_id: "org-1", is_active: true };
  estado.erroNoInsert = null;
  estado.inseridos = [];
  estado.consultasAFonte = [];
  rate.mockReset();
  rate.mockResolvedValue({ allowed: true });
});

describe("POST /api/v1/rastreio/clique/[token]", () => {
  it("⭐ grava o clique com a organização da FONTE e só os parâmetros da allowlist", async () => {
    const res = await chama(
      req(new URLSearchParams({ codigo: "k7m2qx", gclid: "Cj0K_ABC", utm_source: "google", senha: "123", organization_id: "org-INVASORA" }).toString()),
    );
    expect(res.status).toBe(204);
    expect(estado.inseridos).toHaveLength(1);
    expect(estado.inseridos[0]).toMatchObject({
      organization_id: "org-1",
      codigo: "K7M2QX",
      parametros: { gclid: "Cj0K_ABC", utm_source: "google" },
    });
    expect(JSON.stringify(estado.inseridos[0])).not.toContain("org-INVASORA");
    expect(JSON.stringify(estado.inseridos[0])).not.toContain("senha");
  });

  it("aceita JSON também", async () => {
    const res = await chama(req(JSON.stringify({ codigo: "K7M2QX", gclid: "A1" }), { tipo: "application/json" }));
    expect(res.status).toBe(204);
    expect(estado.inseridos[0]).toMatchObject({ parametros: { gclid: "A1" } });
  });

  it("⭐ token desconhecido ou fonte desativada: 404, nada gravado", async () => {
    estado.fonte = null;
    expect((await chama(req("codigo=K7M2QX&gclid=A"))).status).toBe(404);
    estado.fonte = { organization_id: "org-1", is_active: false };
    expect((await chama(req("codigo=K7M2QX&gclid=A"))).status).toBe(404);
    expect(estado.inseridos).toHaveLength(0);
  });

  it("token curto demais nem consulta o banco", async () => {
    expect((await chama(req("codigo=K7M2QX&gclid=A"), "curto")).status).toBe(404);
    expect(estado.consultasAFonte).toHaveLength(0);
  });

  it("⭐ limite de taxa (por token OU por IP): 429, nada gravado", async () => {
    rate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
    const res = await chama(req("codigo=K7M2QX&gclid=A"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(estado.inseridos).toHaveLength(0);
  });

  it("limita por token e por IP, com chaves diferentes", async () => {
    await chama(req("codigo=K7M2QX&gclid=A", { ip: "198.51.100.9" }));
    const chaves = rate.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(chaves).toContain(`rastreio_clique:${TOKEN}`);
    expect(chaves).toContain("rastreio_clique_ip:198.51.100.9");
  });

  it("código inválido: 400 (e não grava)", async () => {
    expect((await chama(req("codigo=K7M2Q0&gclid=A"))).status).toBe(400);
    expect((await chama(req("gclid=A"))).status).toBe(400);
    expect(estado.inseridos).toHaveLength(0);
  });

  it("⭐ clique sem nenhum sinal de anúncio (acesso direto): 204 sem gravar", async () => {
    const res = await chama(req("codigo=K7M2QX&landing_url=https%3A%2F%2Flp.exemplo%2F"));
    expect(res.status).toBe(204);
    expect(estado.inseridos).toHaveLength(0);
  });

  it("⭐ o mesmo código duas vezes (sendBeacon reenviou): 204, o primeiro vale", async () => {
    estado.erroNoInsert = { code: "23505", message: "duplicate key" };
    expect((await chama(req("codigo=K7M2QX&gclid=A"))).status).toBe(204);
  });

  it("falha real de escrita: 500", async () => {
    estado.erroNoInsert = { code: "XX000", message: "boom" };
    expect((await chama(req("codigo=K7M2QX&gclid=A"))).status).toBe(500);
  });

  it("⭐ corpo grande demais: 413, antes de qualquer consulta", async () => {
    const res = await chama(req("codigo=K7M2QX&gclid=" + "a".repeat(9000)));
    expect(res.status).toBe(413);
    expect(estado.consultasAFonte).toHaveLength(0);
  });

  it("JSON quebrado: 400", async () => {
    expect((await chama(req("{nao e json", { tipo: "application/json" }))).status).toBe(400);
  });
});
