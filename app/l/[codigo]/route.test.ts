import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  destino: null as string | null,
  erro: null as { message: string } | null,
  chamadas: [] as unknown[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (nome: string, args: unknown) => {
      estado.chamadas.push([nome, args]);
      return Promise.resolve({ data: estado.destino, error: estado.erro });
    },
  }),
}));

import { GET } from "./route";

const abrir = (codigo: string) =>
  GET(new Request(`https://crm.exemplo/l/${codigo}`) as unknown as NextRequest, {
    params: Promise.resolve({ codigo }),
  });

beforeEach(() => {
  estado.destino = null;
  estado.erro = null;
  estado.chamadas = [];
});

describe("GET /l/[codigo]", () => {
  it("conta o clique e redireciona para o destino da campanha", async () => {
    estado.destino = "https://chat.whatsapp.com/AbC123";
    const r = await abrir("Kq7mZp2xYw");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://chat.whatsapp.com/AbC123");
    expect(estado.chamadas).toEqual([["fn_registrar_clique_do_link", { p_codigo: "Kq7mZp2xYw" }]]);
  });

  it("código desconhecido é 404, sem redirecionar", async () => {
    const r = await abrir("Kq7mZp2xYw");
    expect(r.status).toBe(404);
    expect(r.headers.get("location")).toBeNull();
  });

  it("código fora do formato nem consulta o banco", async () => {
    const r = await abrir("abc");
    expect(r.status).toBe(404);
    expect(estado.chamadas).toHaveLength(0);
  });

  it("o link de exemplo da revisão da Meta abre uma página, não 404", async () => {
    const r = await abrir("exemplo");
    expect(r.status).toBe(200);
    expect(estado.chamadas).toHaveLength(0);
  });

  it("destino que não é http(s) não vira redirecionamento", async () => {
    estado.destino = "javascript:alert(1)";
    expect((await abrir("Kq7mZp2xYw")).status).toBe(404);
  });
});
