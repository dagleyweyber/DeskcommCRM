import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { atualizarContadores } from "./dispatch";

/**
 * Banco falso que imita o limite do PostgREST: nenhuma consulta devolve mais de 1.000 linhas,
 * mesmo pedindo mais — o que o simulador de Postgres dos testes de invariante NÃO faz, e por
 * isso o defeito (contador em 0, `completed` antes da hora) passava por lá.
 */
function bancoFalso(statuses: string[]) {
  const gravado: Array<Record<string, unknown>> = [];
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    order: () => consulta,
    range: async (de: number, ate: number) => ({
      data: statuses.slice(de, Math.min(ate + 1, de + 1000)).map((status) => ({ status })),
      error: null,
    }),
    update: (valores: Record<string, unknown>) => {
      gravado.push(valores);
      return { eq: async () => ({ error: null }) };
    },
  };
  return { admin: { from: () => consulta } as unknown as SupabaseClient, gravado };
}

describe("atualizarContadores", () => {
  it("⭐ campanha com mais de 1.000 destinatários conta todos, não só a primeira página", async () => {
    // As mil primeiras ainda pendentes e as demais enviadas: lido de uma vez, daria 0 enviadas.
    const statuses = [...Array(1000).fill("pending"), ...Array(1000).fill("sent")];
    const { admin, gravado } = bancoFalso(statuses);

    await atualizarContadores(admin, "c1");

    expect(gravado).toHaveLength(1);
    expect(gravado[0]).toMatchObject({ sent_count: 1000, failed_count: 0 });
    expect(gravado[0]).not.toHaveProperty("status"); // sobra pendente: continua rodando
  });

  it("⭐ não fecha a campanha como `completed` se o que sobra pendente está além da primeira página", async () => {
    const statuses = [...Array(1000).fill("sent"), ...Array(100).fill("pending")];
    const { admin, gravado } = bancoFalso(statuses);

    await atualizarContadores(admin, "c1");

    expect(gravado[0]).toMatchObject({ sent_count: 1000 });
    expect(gravado[0]).not.toHaveProperty("status");
  });

  it("fecha como `completed` quando nada resta pendente, contando as falhas", async () => {
    const statuses = [...Array(1500).fill("sent"), ...Array(7).fill("failed")];
    const { admin, gravado } = bancoFalso(statuses);

    await atualizarContadores(admin, "c1");

    expect(gravado[0]).toMatchObject({ sent_count: 1500, failed_count: 7, status: "completed" });
  });
});
