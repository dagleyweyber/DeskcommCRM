import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registrar = vi.fn(async (..._a: unknown[]) => "criado");
vi.mock("@/lib/channels/aviso-de-canal", () => ({ registrarAviso: (...a: unknown[]) => registrar(...a) }));

import { CODIGO_META_COBRANCA, pausarSeCobrancaRecusada } from "./cobranca-recusada";

const campanha = { id: "c1", organization_id: "o1", channel_session_id: "s1", name: "2000 Campanha 11:11" };

/** Banco falso por tabela: cada consulta devolve a linha que a tabela tem, e `update` fica registrado. */
function bancoFalso(opcoes: { enviados: string[]; falhas: Array<{ failure_code: number }> }) {
  const atualizacoes: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
  const linhas: Record<string, unknown> = {
    whatsapp_campaign_recipients: opcoes.enviados.map((external_id) => ({ external_id })),
    messages: opcoes.falhas.map((f) => ({ metadata: f })),
    channel_sessions: { display_name: "B'laser Caruaru Recpção" },
  };
  const consulta = (tabela: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "in"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: linhas[tabela] });
    q.then = (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela], error: null });
    q.update = (valores: Record<string, unknown>) => {
      atualizacoes.push({ tabela, valores });
      const u: Record<string, unknown> = {};
      u.eq = () => u;
      u.then = (ok: (v: unknown) => unknown) => ok({ error: null });
      return u;
    };
    return q;
  };
  return { admin: { from: consulta } as unknown as SupabaseClient, atualizacoes };
}

const recusada = { failure_code: CODIGO_META_COBRANCA };

describe("pausarSeCobrancaRecusada", () => {
  beforeEach(() => registrar.mockClear());

  it("⭐ a maioria das últimas mensagens voltou com erro de cobrança: pausa a campanha e avisa", async () => {
    const { admin, atualizacoes } = bancoFalso({ enviados: ["a", "b", "c", "d", "e"], falhas: [recusada, recusada, recusada] });

    expect(await pausarSeCobrancaRecusada(admin, campanha)).toBe(true);

    expect(atualizacoes).toContainEqual({ tabela: "whatsapp_campaigns", valores: { status: "paused" } });
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar.mock.calls[0]![2]).toMatchObject({
      kind: "channel_number_alert",
      severity: "critical",
      title: expect.stringContaining("Caruaru"),
    });
  });

  it("uma ou duas recusadas (cartão ainda propagando) NÃO pausam", async () => {
    const { admin, atualizacoes } = bancoFalso({ enviados: ["a", "b", "c", "d", "e"], falhas: [recusada, recusada] });

    expect(await pausarSeCobrancaRecusada(admin, campanha)).toBe(false);
    expect(atualizacoes).toHaveLength(0);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("falha por OUTRO motivo (ex.: número sem WhatsApp) não conta como cobrança", async () => {
    const outra = { failure_code: 131026 };
    const { admin, atualizacoes } = bancoFalso({ enviados: ["a", "b", "c"], falhas: [outra, outra, outra] });

    expect(await pausarSeCobrancaRecusada(admin, campanha)).toBe(false);
    expect(atualizacoes).toHaveLength(0);
  });

  it("campanha que ainda não enviou nada segue normalmente", async () => {
    const { admin } = bancoFalso({ enviados: [], falhas: [] });
    expect(await pausarSeCobrancaRecusada(admin, campanha)).toBe(false);
  });
});
