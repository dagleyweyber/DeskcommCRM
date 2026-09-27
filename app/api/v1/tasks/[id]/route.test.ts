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

function fazerSupabase(respostas: Resposta[]) {
  const filtros: Array<[string, unknown]> = [];
  let i = 0;
  const proxima = (): Resposta => respostas[Math.min(i++, respostas.length - 1)] ?? { data: null };

  const from = () => {
    const elo: Record<string, unknown> = {};
    const devolve = () => {
      const r = proxima();
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    for (const metodo of ["select", "insert", "update", "delete", "order", "limit"]) {
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
  return { filtros };
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

describe("PATCH e DELETE /api/v1/tasks/[id]", () => {
  const ctx = { params: Promise.resolve({ id: TAREFA }) };

  function patch(corpo: Record<string, unknown>) {
    return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("concluir uma tarefa aberta deixa UMA linha de conclusão na timeline", async () => {
    // 1ª resposta: o status ANTES. 2ª: a linha depois do update.
    fazerSupabase([
      { data: { status: "pending" } },
      { data: { ...LINHA, lead_id: LEAD, status: "done" } },
    ]);
    const { PATCH } = await import("./route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "task_completed" }),
    );
  });

  it("salvar de novo uma tarefa JÁ concluída não repete a linha", async () => {
    fazerSupabase([
      { data: { status: "done" } },
      { data: { ...LINHA, lead_id: LEAD, status: "done" } },
    ]);
    const { PATCH } = await import("./route");

    await PATCH(patch({ status: "done" }), ctx);

    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("PATCH vazio é 422 — a tela não pode dizer 'salvo' sobre nada", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { PATCH } = await import("./route");

    const res = await PATCH(patch({}), ctx);

    expect(res.status).toBe(422);
  });

  it("tarefa de outra organização no PATCH é 404", async () => {
    fazerSupabase([
      { data: { status: "pending" } },
      { error: { code: "PGRST116", message: "not found" } },
    ]);
    const { PATCH } = await import("./route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(404);
  });

  it("apagar tarefa de outra organização é 404, não 200", async () => {
    // O `.eq(organization_id)` casa zero linhas. Sem o `.select()` no delete,
    // isso devolveria 200 e a tela sumiria com uma linha que ninguém apagou.
    const espiao = fazerSupabase([{ data: [] }]);
    const { DELETE } = await import("./route");

    const res = await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`), ctx);

    expect(res.status).toBe(404);
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("apagar com sucesso audita crm_task.deleted", async () => {
    fazerSupabase([{ data: [{ id: TAREFA }] }]);
    const { DELETE } = await import("./route");

    const res = await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm_task.deleted", resourceId: TAREFA }),
    );
  });
});
