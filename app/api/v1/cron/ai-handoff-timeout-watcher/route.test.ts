import { beforeEach, describe, expect, it, vi } from "vitest";

const CONV_OK = "cccccccc-0000-4000-8000-000000000001";
const CONV_CONFLITO = "cccccccc-0000-4000-8000-000000000002";
const ORG = "dddddddd-0000-4000-8000-000000000001";

const chamadas: { conversationId: string }[] = [];
let resultadoParaConversa: Record<string, { ok: boolean; erro?: string }>;

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({
      data: [
        { conversation_id: CONV_OK, organization_id: ORG },
        { conversation_id: CONV_CONFLITO, organization_id: ORG },
      ],
      error: null,
    }),
  }),
}));

vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: vi.fn(async (_deps: unknown, input: { conversationId: string }) => {
    chamadas.push({ conversationId: input.conversationId });
    const r = resultadoParaConversa[input.conversationId];
    if (r?.ok === false) return { ok: false, erro: r.erro };
    return {
      ok: true,
      conversationId: input.conversationId,
      jaEstavaComOAgente: false,
      continuidade: { houveAtendimentoHumano: false, resumo: "", decisoes: [], notas: [] },
    };
  }),
}));

import { POST } from "@/app/api/v1/cron/ai-handoff-timeout-watcher/route";

beforeEach(() => {
  chamadas.length = 0;
  resultadoParaConversa = {
    [CONV_CONFLITO]: { ok: false, erro: "assignment_conflict" },
  };
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/ai-handoff-timeout-watcher", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

describe("ai-handoff-timeout-watcher", () => {
  it("⭐ devolve toda conversa devida ao agente, e conta só as que realmente devolveram", async () => {
    const resposta = await chamar();
    const body = (await resposta.json()) as { data: { scanned: number; returned: number } };

    expect(resposta.status).toBe(200);
    expect(chamadas.map((c) => c.conversationId).sort()).toEqual([CONV_CONFLITO, CONV_OK].sort());
    // assignment_conflict não é falha do watcher — é a corrida resolvida a favor
    // de quem respondeu/assumiu entre o SELECT e a devolução. Só conta a que valeu.
    expect(body.data.scanned).toBe(2);
    expect(body.data.returned).toBe(1);
  });

  it("recusa sem o Bearer certo", async () => {
    const resposta = await POST(
      new Request("http://localhost/api/v1/cron/ai-handoff-timeout-watcher", { method: "POST" }) as never,
    );
    expect(resposta.status).toBe(403);
    expect(chamadas).toHaveLength(0);
  });
});
