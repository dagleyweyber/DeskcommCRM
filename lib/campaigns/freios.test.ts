import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registrar = vi.fn(async (..._a: unknown[]) => "criado");
vi.mock("@/lib/channels/aviso-de-canal", () => ({ registrarAviso: (...a: unknown[]) => registrar(...a) }));

import {
  CODIGO_META_COBRANCA,
  freioAntesDaRodada,
  freioDeSaidas,
  freioDoErroDeEnvio,
  freioDoEstado,
  pausarCampanha,
  pausarCampanhasAtivas,
} from "./freios";

const campanha = {
  id: "c1",
  organization_id: "o1",
  channel_session_id: "s1",
  name: "2000 Campanha 11:11",
  template_name: "campanha_11_11",
  template_language: "pt_BR",
};
const aprovado = { status: "APPROVED", quality_score: "GREEN" };

/** Banco falso por tabela: cada consulta devolve o que a tabela tem; `update` e `rpc` ficam registrados. */
function bancoFalso(opcoes: {
  enviados?: string[];
  falhas?: Array<{ failure_code: number }>;
  campanhas?: Array<Record<string, unknown>>;
  resultado?: Record<string, unknown>;
  pausaAfeta?: boolean;
}) {
  const atualizacoes: Array<{ tabela: string; valores: Record<string, unknown>; filtros: unknown[][] }> = [];
  const filtrosDeLeitura: Array<{ tabela: string; filtro: unknown[] }> = [];
  const linhas: Record<string, unknown> = {
    whatsapp_campaign_recipients: (opcoes.enviados ?? []).map((external_id) => ({ external_id })),
    messages: (opcoes.falhas ?? []).map((f) => ({ metadata: f })),
    whatsapp_campaigns: opcoes.campanhas ?? [],
  };
  const consulta = (tabela: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "in", "gte"]) {
      q[m] = (...a: unknown[]) => {
        filtrosDeLeitura.push({ tabela, filtro: [m, ...a] });
        return q;
      };
    }
    q.then = (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela], error: null });
    q.update = (valores: Record<string, unknown>) => {
      const registro = { tabela, valores, filtros: [] as unknown[][] };
      atualizacoes.push(registro);
      const u: Record<string, unknown> = {};
      u.eq = (...a: unknown[]) => {
        registro.filtros.push(a);
        return u;
      };
      u.select = () => u;
      u.then = (ok: (v: unknown) => unknown) =>
        ok({ data: opcoes.pausaAfeta === false ? [] : [{ id: "x" }], error: null });
      return u;
    };
    return q;
  };
  const admin = {
    from: consulta,
    rpc: async () => ({ data: opcoes.resultado ?? null, error: null }),
  } as unknown as SupabaseClient;
  return { admin, atualizacoes, filtrosDeLeitura };
}

const recusada = { failure_code: CODIGO_META_COBRANCA };

describe("freioDoEstado — o que o modelo e o número dizem", () => {
  it("⭐ modelo pausado pela Meta para a campanha", () => {
    expect(freioDoEstado(campanha, { modelo: { status: "PAUSED", quality_score: "RED" }, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "modelo_pausado" });
  });

  it("modelo reprovado/desativado vira `modelo_desativado`", () => {
    expect(freioDoEstado(campanha, { modelo: { status: "DISABLED", quality_score: null }, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "modelo_desativado" });
  });

  it("⭐ nota amarela e nota vermelha param; verde segue", () => {
    expect(freioDoEstado(campanha, { modelo: { status: "APPROVED", quality_score: "YELLOW" }, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "modelo_nota_amarela" });
    expect(freioDoEstado(campanha, { modelo: { status: "APPROVED", quality_score: "RED" }, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "modelo_nota_vermelha" });
    expect(freioDoEstado(campanha, { modelo: aprovado, qualidadeDoNumero: "GREEN" })).toBeNull();
  });

  it("nota dispensada ao retomar não para de novo — e a vermelha dispensada cobre a amarela", () => {
    const amarela = { modelo: { status: "APPROVED", quality_score: "YELLOW" }, qualidadeDoNumero: null };
    expect(freioDoEstado({ ...campanha, freios_dispensados: ["modelo_nota_amarela"] }, amarela)).toBeNull();
    expect(freioDoEstado({ ...campanha, freios_dispensados: ["modelo_nota_vermelha"] }, amarela)).toBeNull();
  });

  it("modelo pausado NÃO é dispensável: a Meta não entrega", () => {
    const c = { ...campanha, freios_dispensados: ["modelo_nota_vermelha", "modelo_pausado"] };
    expect(freioDoEstado(c, { modelo: { status: "PAUSED", quality_score: "RED" }, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "modelo_pausado" });
  });

  it("número com qualidade vermelha para a campanha", () => {
    expect(freioDoEstado(campanha, { modelo: aprovado, qualidadeDoNumero: "RED" }))
      .toMatchObject({ motivo: "numero_qualidade_baixa" });
  });
});

describe("freioDeSaidas — pedidos para sair acima de 2%", () => {
  it("⭐ 3 de 100 entregues (3%) param", () => {
    expect(freioDeSaidas({ aceitas: 120, entregues: 100, saidas: 3 })).toMatchObject({ motivo: "saidas_acima_do_limite" });
  });

  it("1 de 100 (1%) segue", () => {
    expect(freioDeSaidas({ aceitas: 100, entregues: 100, saidas: 1 })).toBeNull();
  });

  it("base pequena não decide: 2 saídas em 40 entregues (5%) ainda não param", () => {
    expect(freioDeSaidas({ aceitas: 40, entregues: 40, saidas: 2 })).toBeNull();
  });

  it("sem status de entrega, a base é o que a Meta aceitou", () => {
    expect(freioDeSaidas({ aceitas: 200, entregues: 0, saidas: 5 })).toMatchObject({ motivo: "saidas_acima_do_limite" });
  });
});

describe("freioDoErroDeEnvio — a Meta recusou o modelo na hora do envio", () => {
  it("⭐ 132015 (modelo pausado) e 132016 (desativado) param a campanha", () => {
    expect(freioDoErroDeEnvio("meta_132015: Template is paused", "m")).toMatchObject({ motivo: "modelo_pausado" });
    expect(freioDoErroDeEnvio("meta_132016: Template is disabled", "m")).toMatchObject({ motivo: "modelo_desativado" });
  });

  it("modelo não aprovado na conferência local também para", () => {
    expect(freioDoErroDeEnvio('template_not_approved: "m" (pt_BR) está PAUSED', "m")).toMatchObject({ motivo: "modelo_pausado" });
  });

  it("falha de UM contato (número sem WhatsApp) não para nada", () => {
    expect(freioDoErroDeEnvio("meta_131026: Message undeliverable", "m")).toBeNull();
  });
});

describe("freioAntesDaRodada — cobrança", () => {
  beforeEach(() => registrar.mockClear());

  it("⭐ a maioria das últimas mensagens recusada por cobrança para a campanha", async () => {
    const { admin } = bancoFalso({ enviados: ["a", "b", "c", "d", "e"], falhas: [recusada, recusada, recusada] });
    expect(await freioAntesDaRodada(admin, campanha, { modelo: aprovado, qualidadeDoNumero: null }))
      .toMatchObject({ motivo: "cobranca_recusada" });
  });

  it("uma ou duas recusadas (cartão ainda propagando) NÃO param", async () => {
    const { admin } = bancoFalso({
      enviados: ["a", "b", "c", "d", "e"],
      falhas: [recusada, recusada],
      resultado: { aceitas: 5, entregues: 3, saidas: 0 },
    });
    expect(await freioAntesDaRodada(admin, campanha, { modelo: aprovado, qualidadeDoNumero: null })).toBeNull();
  });

  it("⭐ depois de retomar, só olha o que saiu DEPOIS da retomada (senão pausaria de novo na hora)", async () => {
    const { admin, filtrosDeLeitura } = bancoFalso({ enviados: [], resultado: { aceitas: 0, entregues: 0, saidas: 0 } });
    await freioAntesDaRodada(admin, { ...campanha, retomada_em: "2026-11-10T12:00:00Z" }, { modelo: aprovado, qualidadeDoNumero: null });
    expect(filtrosDeLeitura).toContainEqual({
      tabela: "whatsapp_campaign_recipients",
      filtro: ["gte", "sent_at", "2026-11-10T12:00:00Z"],
    });
  });
});

describe("pausarCampanha", () => {
  beforeEach(() => registrar.mockClear());

  it("⭐ grava o motivo na campanha e abre aviso crítico na Central", async () => {
    const { admin, atualizacoes } = bancoFalso({});
    const pausou = await pausarCampanha(admin, campanha, { motivo: "modelo_pausado", detalhe: "A Meta pausou." });

    expect(pausou).toBe(true);
    expect(atualizacoes[0]!.valores).toMatchObject({ status: "paused", pausa_motivo: "modelo_pausado", pausa_detalhe: "A Meta pausou." });
    expect(atualizacoes[0]!.filtros).toContainEqual(["status", "running"]);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar.mock.calls[0]![2]).toMatchObject({ severity: "critical", title: expect.stringContaining("2000 Campanha 11:11") });
  });

  it("campanha que não estava andando (cancelada, concluída) não é tocada nem avisada", async () => {
    const { admin } = bancoFalso({ pausaAfeta: false });
    expect(await pausarCampanha(admin, campanha, { motivo: "modelo_pausado", detalhe: "x" })).toBe(false);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("pelo aviso da Meta: pula a campanha que já dispensou este motivo ao retomar", async () => {
    const { admin } = bancoFalso({
      campanhas: [
        { id: "c1", organization_id: "o1", name: "A", freios_dispensados: [] },
        { id: "c2", organization_id: "o1", name: "B", freios_dispensados: ["modelo_nota_amarela"] },
      ],
    });
    const n = await pausarCampanhasAtivas(
      admin,
      { organizationId: "o1", channelSessionIds: ["s1"], templateName: "m" },
      { motivo: "modelo_nota_amarela", detalhe: "amarela" },
    );
    expect(n).toBe(1);
  });
});
