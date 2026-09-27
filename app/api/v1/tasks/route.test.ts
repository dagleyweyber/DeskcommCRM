/**
 * A ROTA DE TAREFAS NÃO TEM PORTA DOS FUNDOS.
 *
 * Este arquivo guarda o que este módulo NUNCA fez, mas que era fácil de
 * reintroduzir num porte: um caminho paralelo que grava tarefa em
 * `crm_leads.custom_fields` quando `crm_tasks` falta, transformando "o banco
 * desta instalação está desatualizado" em 200 OK silencioso. Isso é o pior
 * tipo de rede — o dado vai pra um lugar que nenhuma lista, índice ou policy
 * alcança, e um mês depois a tarefa some sem ninguém saber por quê.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const LEAD = "44444444-4444-4444-8444-444444444444";
const TAREFA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

interface Resposta {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

/**
 * Dublê do PostgREST que ANOTA o que foi tocado.
 *
 * `tabelas` é o instrumento: sem ele, "só toca crm_tasks" seria uma afirmação
 * sobre o que eu li no fonte, não sobre o que a rota fez.
 */
function fazerSupabase(respostas: Resposta[]) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  let i = 0;
  const proxima = (): Resposta => respostas[Math.min(i++, respostas.length - 1)] ?? { data: null };

  const from = (tabela: string) => {
    tabelas.push(tabela);
    const elo: Record<string, unknown> = {};
    const devolve = () => {
      const r = proxima();
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    for (const metodo of ["select", "insert", "update", "delete", "order", "limit", "in", "gte", "lte"]) {
      elo[metodo] = () => elo;
    }
    elo.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return elo;
    };
    elo.single = devolve;
    elo.maybeSingle = devolve;
    elo.then = (res: (v: unknown) => unknown) => devolve().then(res);
    return elo;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return { tabelas, filtros };
}

const LINHA = {
  id: TAREFA,
  organization_id: ORG,
  title: "Ligar de volta",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: null,
  contact_id: null,
  assigned_to: null,
  created_by: ANA,
  created_at: "2026-09-27T10:00:00.000Z",
  updated_at: "2026-09-27T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessao("agent");
});

describe("GET /api/v1/tasks", () => {
  it("filtra pela org da SESSÃO, mesmo com outra org na query", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`http://x/api/v1/tasks?organization_id=${OUTRA_ORG}`),
    );

    expect(res.status).toBe(200);
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(espiao.filtros.flat()).not.toContain(OUTRA_ORG);
  });

  it("só toca crm_tasks", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("./route");

    await GET(new NextRequest("http://x/api/v1/tasks"));

    expect(espiao.tabelas).toEqual(["crm_tasks"]);
  });

  it('"a tabela não existe" vira 500, nunca 200 com o dado em outro lugar', async () => {
    const espiao = fazerSupabase([
      { error: { code: "42P01", message: 'relation "crm_tasks" does not exist' } },
    ]);
    const { GET } = await import("./route");

    const res = await GET(new NextRequest("http://x/api/v1/tasks"));

    expect(res.status).toBe(500);
    expect(espiao.tabelas).toEqual(["crm_tasks"]);
  });
});

describe("POST /api/v1/tasks", () => {
  function pedido(corpo: Record<string, unknown>) {
    return new NextRequest("http://x/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("grava com a org e o autor da sessão, audita e devolve 201", async () => {
    const espiao = fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("./route");

    const res = await POST(pedido({ title: "Ligar de volta" }));

    expect(res.status).toBe(201);
    expect(espiao.tabelas).toEqual(["crm_tasks"]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.created",
        organizationId: ORG,
        actorUserId: ANA,
      }),
    );
  });

  it("tarefa presa a um negócio deixa linha na timeline dele", async () => {
    fazerSupabase([{ data: { ...LINHA, lead_id: LEAD } }]);
    const { POST } = await import("./route");

    await POST(pedido({ title: "Ligar de volta", lead_id: LEAD }));

    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD, type: "task_created" }),
    );
  });

  it("tarefa SOLTA não inventa timeline — lead_id é not null lá", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("./route");

    await POST(pedido({ title: "Revisar os textos do agente" }));

    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("título vazio é recusado com 422, não gravado como espaço", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("./route");

    const res = await POST(pedido({ title: "   " }));

    expect(res.status).toBe(422);
  });

  it("viewer não cria tarefa", async () => {
    sessao("viewer");
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("./route");

    const res = await POST(pedido({ title: "Ligar de volta" }));

    expect(res.status).toBe(403);
  });
});
