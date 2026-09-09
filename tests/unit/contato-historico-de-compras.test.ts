import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/contacts/[id]/purchases — pedido explícito do dono da agência:
 * quem compra 2, 3, 4+ vezes precisa ver data/valor/produto num resumo,
 * na Visão geral do contato, sem abrir a timeline inteira.
 *
 * Confirmação de sessão + leitura de `crm_leads` via RLS — mesmo padrão de
 * `crm-summary/route.ts`, que já tem o porquê documentado (cliente do
 * browser não carrega a sessão httpOnly, esta rota corre no servidor).
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

function fakeSupabase(leads: Record<string, unknown>[]) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: (tabela: string) => {
      expect(tabela).toBe("crm_leads");
      return {
        select: () => ({
          eq: (coluna: string, valor: string) => {
            expect(["contact_id", "status"]).toContain(coluna);
            if (coluna === "contact_id") expect(valor).toBe(CONTACT_ID);
            if (coluna === "status") expect(valor).toBe("won");
            return {
              eq: (coluna2: string, valor2: string) => {
                expect(["contact_id", "status"]).toContain(coluna2);
                if (coluna2 === "status") expect(valor2).toBe("won");
                return {
                  order: () => Promise.resolve({ data: leads, error: null }),
                };
              },
            };
          },
        }),
      };
    },
  };
}

async function chamar(leads: Record<string, unknown>[]) {
  vi.mocked(createClient).mockResolvedValue(fakeSupabase(leads) as never);
  const { GET } = await import("@/app/api/v1/contacts/[id]/purchases/route");
  const req = new NextRequest(`http://localhost/api/v1/contacts/${CONTACT_ID}/purchases`);
  const res = await GET(req, { params: Promise.resolve({ id: CONTACT_ID }) });
  return (await res.json()) as { data: { purchases: unknown[] } };
}

describe("histórico de compras — só WON, com produto extraído de custom_fields", () => {
  it("⭐ extrai produto_interesse de custom_fields, e 'Não informado' vira null explícito quando falta", async () => {
    const body = await chamar([
      {
        id: "lead-1",
        title: "Corte + Escova",
        closed_at: "2026-08-01T12:00:00Z",
        value_cents: 15000,
        currency: "BRL",
        custom_fields: { produto_interesse: "Corte de cabelo" },
      },
      {
        id: "lead-2",
        title: "Sem produto",
        closed_at: "2026-08-15T12:00:00Z",
        value_cents: 8000,
        currency: "BRL",
        custom_fields: {},
      },
    ]);

    expect(body.data.purchases).toHaveLength(2);
    expect(body.data.purchases[0]).toMatchObject({ id: "lead-1", produto: "Corte de cabelo" });
    // O rótulo "Não informado" é decisão da TELA, não da API — a API devolve
    // null explícito, o mesmo contrato que o resto do repo usa pra "sem
    // valor" (nunca a string mágica embutida na resposta).
    expect(body.data.purchases[1]).toMatchObject({ id: "lead-2", produto: null });
  });

  it("lista vazia quando o contato nunca comprou", async () => {
    const body = await chamar([]);
    expect(body.data.purchases).toEqual([]);
  });
});
