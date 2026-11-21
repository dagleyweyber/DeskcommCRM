import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/webhooks/agenda/[token] — a porta pública dos avisos do Uno e do Zandu.
 * O que só a rota garante:
 *  - endereço desconhecido → 404 (e nada gravado);
 *  - Uno sem o token certo no cabeçalho → 401 (e nada gravado);
 *  - aviso válido é GRAVADO antes de processar, com a org vinda da CONEXÃO, nunca do corpo;
 *  - falha ao processar não vira erro para o remetente: o aviso já está guardado.
 */
const TOKEN_DO_UNO = "segredo-que-o-crm-gerou-para-o-uno";
const CAMINHO = "caminho-secreto-com-mais-de-16";

const estado = vi.hoisted(() => ({
  conexao: null as Record<string, unknown> | null,
  gravados: [] as Record<string, unknown>[],
  processar: vi.fn(),
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/agenda-externa/avisos", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  processarAviso: estado.processar,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "calendar_integrations") {
        const filtros: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => ((filtros[c] = v), q),
          in: () => q,
          maybeSingle: async () => ({
            data: estado.conexao && filtros.inbound_path_token === estado.conexao.inbound_path_token ? estado.conexao : null,
            error: null,
          }),
        };
        return q;
      }
      if (tabela === "calendar_integration_events") {
        return {
          insert: (linha: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                estado.gravados.push(linha);
                return { data: { id: "aviso-1", payload: linha.payload, received_at: "2026-11-21T12:00:00Z", attempts: 0 }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada ${tabela}`);
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/agenda/[token]/route";

function conexao(provider: "uno" | "zandu") {
  return {
    id: "integ-1",
    organization_id: "org-da-conexao",
    provider,
    credential_encrypted: null,
    external_account_id: null,
    default_area_code: null,
    initial_sync_done_at: null,
    far_window_index: 0,
    inbound_path_token: CAMINHO,
    inbound_secret_hash: provider === "uno" ? createHash("sha256").update(TOKEN_DO_UNO).digest("hex") : null,
  };
}

const corpoUno = {
  event: "APPOINTMENT_CREATED",
  schema: "empresa_x",
  organization_id: "org-de-outro-cliente",
  appointment: { id: 1, startDate: "2026-11-25T14:00:00-03:00", customer: { id: 1, name: "Ana" } },
};

function chamar(token: string, corpo: unknown, cabecalhos: Record<string, string> = {}) {
  const req = new NextRequest(`https://crm.exemplo/api/v1/webhooks/agenda/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  estado.conexao = null;
  estado.gravados = [];
  estado.processar.mockReset();
  estado.processar.mockResolvedValue({ ok: true, aplicado: true, motivo: null, contagem: {} });
});

describe("webhook de agenda", () => {
  it("endereço desconhecido → 404, nada gravado", async () => {
    estado.conexao = conexao("uno");
    const r = await chamar("outro-caminho-qualquer-xx", corpoUno, { "x-uno-webhook-token": TOKEN_DO_UNO });
    expect(r.status).toBe(404);
    expect(estado.gravados).toHaveLength(0);
  });

  it("⭐ Uno sem token ou com token errado → 401, nada gravado", async () => {
    estado.conexao = conexao("uno");
    expect((await chamar(CAMINHO, corpoUno)).status).toBe(401);
    expect((await chamar(CAMINHO, corpoUno, { "x-uno-webhook-token": "chute" })).status).toBe(401);
    expect(estado.gravados).toHaveLength(0);
    expect(estado.processar).not.toHaveBeenCalled();
  });

  it("⭐ Uno com o token certo: grava na org DA CONEXÃO (não a do corpo) e processa", async () => {
    estado.conexao = conexao("uno");
    const r = await chamar(CAMINHO, corpoUno, { "x-uno-webhook-token": TOKEN_DO_UNO });
    expect(r.status).toBe(200);
    expect(estado.gravados).toHaveLength(1);
    expect(estado.gravados[0]).toMatchObject({
      organization_id: "org-da-conexao",
      integration_id: "integ-1",
      event_type: "APPOINTMENT_CREATED",
      external_id: "1",
    });
    expect(estado.processar).toHaveBeenCalledTimes(1);
  });

  it("Zandu não tem token de cabeçalho: o endereço é o segredo", async () => {
    estado.conexao = conexao("zandu");
    const r = await chamar(CAMINHO, { event: "appointment.created", appointmentId: "a1", start: "2026-11-25T17:00:00Z" });
    expect(r.status).toBe(200);
    expect(estado.gravados[0]).toMatchObject({ external_id: "a1" });
  });

  it("⭐ processar falhou: o remetente recebe 200 mesmo assim — o aviso já está gravado e o cron tenta de novo", async () => {
    estado.conexao = conexao("zandu");
    estado.processar.mockResolvedValue({ ok: false, aplicado: false, motivo: "falhou", contagem: {} });
    const r = await chamar(CAMINHO, { appointmentId: "a2", start: "2026-11-25T17:00:00Z" });
    expect(r.status).toBe(200);
    expect(estado.gravados).toHaveLength(1);
  });

  it("JSON inválido → 400", async () => {
    estado.conexao = conexao("zandu");
    const req = new NextRequest(`https://crm.exemplo/api/v1/webhooks/agenda/${CAMINHO}`, { method: "POST", body: "{nao é json" });
    const r = await POST(req, { params: Promise.resolve({ token: CAMINHO }) });
    expect(r.status).toBe(400);
  });
});
