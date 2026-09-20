import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_SEM_CREDENCIAL = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_SEM_ATIVIDADE = "aaaaaaaa-0000-4000-8000-000000000002";
const AGENT_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const AGENT_2 = "bbbbbbbb-0000-4000-8000-000000000002";

const inserts: Record<string, unknown>[] = [];
/** Agent ids que já têm aviso `ia_sem_resposta` aberto — controlado por teste. */
let jaAbertoParaAgente: Set<string>;

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({
      data: [
        { organization_id: ORG_SEM_CREDENCIAL, motivo: "sem_credencial", agent_id: AGENT_1 },
        { organization_id: ORG_SEM_ATIVIDADE, motivo: "sem_atividade", agent_id: AGENT_2 },
      ],
      error: null,
    }),
    from: (tabela: string) => {
      if (tabela !== "agent_inbox_items") throw new Error(`tabela inesperada: ${tabela}`);
      let refIdFiltrado: string | null = null;
      const encadeavel = {
        eq: (coluna: string, valor: string) => {
          if (coluna === "ref_id") refIdFiltrado = valor;
          return encadeavel;
        },
        limit: () => encadeavel,
        maybeSingle: async () => ({
          data: refIdFiltrado && jaAbertoParaAgente.has(refIdFiltrado) ? { id: "existente" } : null,
        }),
      };
      return {
        select: () => encadeavel,
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/ai-silence-watcher/route";

beforeEach(() => {
  inserts.length = 0;
  jaAbertoParaAgente = new Set();
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/ai-silence-watcher", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

describe("ai-silence-watcher", () => {
  it("⭐ abre um aviso ia_sem_resposta por organização silenciosa, com o texto certo por motivo", async () => {
    const resposta = await chamar();
    expect(resposta.status).toBe(200);
    expect(inserts).toHaveLength(2);

    const semCredencial = inserts.find((i) => i.organization_id === ORG_SEM_CREDENCIAL);
    expect(semCredencial?.kind).toBe("ia_sem_resposta");
    expect(semCredencial?.severity).toBe("critical");
    expect(semCredencial?.title).toMatch(/sem credencial/i);
    expect(semCredencial?.ref_id).toBe(AGENT_1);

    const semAtividade = inserts.find((i) => i.organization_id === ORG_SEM_ATIVIDADE);
    expect(semAtividade?.title).toMatch(/parou de responder/i);
    expect(semAtividade?.ref_id).toBe(AGENT_2);
  });

  it("não duplica aviso quando já existe um aberto pra este agente", async () => {
    jaAbertoParaAgente.add(AGENT_1);
    const resposta = await chamar();
    expect(resposta.status).toBe(200);
    // Só o de ORG_SEM_ATIVIDADE (agent_id=AGENT_2) deveria abrir — AGENT_1 já tinha.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.organization_id).toBe(ORG_SEM_ATIVIDADE);
  });

  it("recusa sem o Bearer certo", async () => {
    const resposta = await POST(
      new Request("http://localhost/api/v1/cron/ai-silence-watcher", { method: "POST" }) as never,
    );
    expect(resposta.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });
});
