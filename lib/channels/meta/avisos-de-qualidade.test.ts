import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pausar = vi.fn(async (..._a: unknown[]) => 1);
const registrar = vi.fn(async (..._a: unknown[]) => "criado");
vi.mock("@/lib/campaigns/freios", () => ({ pausarCampanhasAtivas: (...a: unknown[]) => pausar(...a) }));
vi.mock("../zernio/avisos", () => ({ registrarAviso: (...a: unknown[]) => registrar(...a) }));

import {
  aplicarAlertaDaConta,
  aplicarQualidadeDoModelo,
  aplicarQualidadeDoNumero,
  pausarPorAvisoDaConta,
  pausarPorEstadoDoModelo,
} from "./avisos-de-qualidade";
import { parseMetaWebhook } from "./webhook";

const session = { id: "s1", organizationId: "o1", wabaId: "W", phoneNumberId: "P1" } as never;

/** Banco falso: cada tabela devolve as linhas dadas; `update` fica registrado. */
function bancoFalso(linhas: Record<string, unknown[]>) {
  const atualizacoes: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela] ?? [], error: null });
    q.update = (valores: Record<string, unknown>) => {
      atualizacoes.push({ tabela, valores });
      return q;
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, atualizacoes };
}

function envelope(field: string, value: Record<string, unknown>) {
  return { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field, value }] }] };
}

beforeEach(() => {
  pausar.mockClear();
  registrar.mockClear();
});

describe("parse dos avisos de qualidade", () => {
  it("⭐ nota do modelo (`message_template_quality_update`)", () => {
    const [e] = parseMetaWebhook(
      envelope("message_template_quality_update", {
        previous_quality_score: "GREEN",
        new_quality_score: "YELLOW",
        message_template_id: 1,
        message_template_name: "campanha_11_11",
        message_template_language: "pt_BR",
      }),
    );
    expect(e).toEqual({
      kind: "template_quality",
      wabaId: "W",
      templateName: "campanha_11_11",
      templateLanguage: "pt_BR",
      newScore: "YELLOW",
      previousScore: "GREEN",
    });
  });

  it("qualidade do número (`phone_number_quality_update`), nas duas grafias do limite", () => {
    const [a] = parseMetaWebhook(envelope("phone_number_quality_update", { display_phone_number: "5581999990000", event: "FLAGGED", current_limit: "TIER_1K" }));
    const [b] = parseMetaWebhook(envelope("phone_number_quality_update", { display_phone_number: "5581999990000", event: "DOWNGRADE", messaging_limit_tier: "TIER_250" }));
    expect(a).toMatchObject({ kind: "phone_quality", event: "FLAGGED", currentLimit: "TIER_1K" });
    expect(b).toMatchObject({ kind: "phone_quality", event: "DOWNGRADE", currentLimit: "TIER_250" });
  });

  it("alerta da conta (`account_alerts`)", () => {
    const [e] = parseMetaWebhook(
      envelope("account_alerts", {
        entity_type: "WABA",
        entity_id: "W",
        alert_info: { alert_severity: "CRITICAL", alert_status: "ACTIVE", alert_type: "X", alert_description: "Conta em risco" },
      }),
    );
    expect(e).toMatchObject({ kind: "account_alert", severity: "CRITICAL", description: "Conta em risco" });
  });

  it("status de entrega carrega QUANDO a Meta registrou", () => {
    const [e] = parseMetaWebhook(
      envelope("messages", { statuses: [{ id: "wamid.A", status: "read", timestamp: "1762780000" }] }),
    );
    expect(e).toMatchObject({ kind: "message_status", status: "read", timestamp: new Date(1762780000 * 1000) });
  });
});

describe("aplicar os avisos", () => {
  it("⭐ nota amarela: grava no modelo, avisa e pausa as campanhas do modelo", async () => {
    const { admin, atualizacoes } = bancoFalso({ meta_templates: [{ channel_session_id: "s1" }] });
    await aplicarQualidadeDoModelo(admin, session, {
      kind: "template_quality",
      wabaId: "W",
      templateName: "campanha_11_11",
      templateLanguage: "pt_BR",
      newScore: "YELLOW",
      previousScore: "GREEN",
    });
    expect(atualizacoes[0]).toMatchObject({ tabela: "meta_templates", valores: { quality_score: "YELLOW" } });
    expect(pausar).toHaveBeenCalledTimes(1);
    expect(pausar.mock.calls[0]![1]).toMatchObject({ channelSessionIds: ["s1"], templateName: "campanha_11_11" });
    expect(pausar.mock.calls[0]![2]).toMatchObject({ motivo: "modelo_nota_amarela" });
  });

  it("nota verde só grava — não pausa nem avisa", async () => {
    const { admin } = bancoFalso({ meta_templates: [{ channel_session_id: "s1" }] });
    await aplicarQualidadeDoModelo(admin, session, {
      kind: "template_quality", wabaId: "W", templateName: "m", templateLanguage: "pt_BR", newScore: "GREEN", previousScore: "YELLOW",
    });
    expect(pausar).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it("⭐ modelo PAUSADO pela Meta pausa as campanhas dele; aprovado não", async () => {
    const { admin } = bancoFalso({ meta_templates: [{ channel_session_id: "s1" }] });
    const base = { kind: "template_status" as const, wabaId: "W", templateName: "m", templateLanguage: "pt_BR", reason: null, category: null };
    await pausarPorEstadoDoModelo(admin, session, { ...base, event: "APPROVED" });
    expect(pausar).not.toHaveBeenCalled();
    await pausarPorEstadoDoModelo(admin, session, { ...base, event: "PAUSED" });
    expect(pausar.mock.calls[0]![2]).toMatchObject({ motivo: "modelo_pausado" });
  });

  it("⭐ número sinalizado (FLAGGED): nota vermelha no número e campanhas dele pausadas", async () => {
    const { admin, atualizacoes } = bancoFalso({
      channel_sessions: [
        { id: "s1", display_name: "Boa Viagem", phone_number: "+55 81 99999-0000" },
        { id: "s2", display_name: "Cabo", phone_number: "+55 81 98888-1111" },
      ],
    });
    await aplicarQualidadeDoNumero(admin, session, {
      kind: "phone_quality", wabaId: "W", displayPhoneNumber: "5581999990000", event: "FLAGGED", currentLimit: "TIER_1K",
    });
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]!.valores).toMatchObject({ meta_quality_rating: "RED", meta_quality_event: "FLAGGED", meta_messaging_limit: "TIER_1K" });
    expect(pausar.mock.calls[0]![1]).toMatchObject({ channelSessionIds: ["s1"] });
    expect(pausar.mock.calls[0]![2]).toMatchObject({ motivo: "numero_qualidade_baixa" });
  });

  it("alerta crítico ou de atenção pausa as campanhas da conta; informativo só avisa", async () => {
    const { admin } = bancoFalso({ channel_sessions: [{ id: "s1" }, { id: "s2" }] });
    const base = { kind: "account_alert" as const, wabaId: "W", entityType: "WABA", entityId: "W", status: "ACTIVE", alertType: null, description: "x" };
    await aplicarAlertaDaConta(admin, session, { ...base, severity: "INFORMATIONAL" });
    expect(pausar).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledTimes(1);
    await aplicarAlertaDaConta(admin, session, { ...base, severity: "WARNING" });
    expect(pausar.mock.calls[0]![1]).toMatchObject({ channelSessionIds: ["s1", "s2"] });
    expect(pausar.mock.calls[0]![2]).toMatchObject({ motivo: "alerta_da_conta" });
  });

  it("violação, restrição e banimento da conta pausam; reconexão não", async () => {
    const { admin } = bancoFalso({ channel_sessions: [{ id: "s1" }] });
    const base = {
      kind: "account_update" as const, wabaId: "W", banState: null, disconnectReason: null,
      disconnectInitiatedBy: null, violationType: null, restrictionType: null,
    };
    await pausarPorAvisoDaConta(admin, session, { ...base, event: "ACCOUNT_RECONNECTED" });
    expect(pausar).not.toHaveBeenCalled();
    await pausarPorAvisoDaConta(admin, session, { ...base, event: "ACCOUNT_VIOLATION", violationType: "SPAM" });
    await pausarPorAvisoDaConta(admin, session, { ...base, event: "DISABLED_UPDATE", banState: "DISABLE" });
    expect(pausar).toHaveBeenCalledTimes(2);
    expect(pausar.mock.calls[0]![2]).toMatchObject({ motivo: "violacao_da_conta", detalhe: expect.stringContaining("SPAM") });
  });
});
