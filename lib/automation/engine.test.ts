import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Achado revisando capacidade antes de escalar pra mais clínicas: o motor
 * gravava o resultado de cada regra em `automation_rule_runs` mas sempre
 * devolvia `status:"ok"` ao dispatcher — uma falha de webhook/WhatsApp
 * ficava só naquela tabela, que nenhuma tela lê. O que se guarda aqui é a
 * correção: regra com ação falha abre aviso na Central, deduplicado por
 * regra (não um aviso por evento), e regra 100% bem-sucedida não abre nada.
 *
 * Deliberadamente NÃO testa reenvio automático — não existe. Reexecutar a
 * regra reenviaria uma ação que já teve sucesso numa run parcial, então o
 * motor continua devolvendo "ok" ao event_log (sem retry); só a VISIBILIDADE
 * mudou.
 */
const executeAction = vi.fn();
vi.mock("@/lib/automation/actions", () => ({
  getAction: (type: string) => (type === "falha_sempre" || type === "sucesso_sempre" ? { type, execute: executeAction } : undefined),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { runAutomationForEvent, AUTOMATION_CONSUMER_KEY } from "./engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

interface Chamada {
  tabela: string;
  op: string;
  valores?: Record<string, unknown>;
  filtros: Record<string, unknown>;
}

function adminDuble(opts: {
  rules: Array<{ id: string; name: string; conditions: unknown[]; actions: Array<{ type: string }> }>;
  inboxJaAberto?: boolean;
}) {
  const chamadas: Chamada[] = [];
  let chamadasAutomationRules = 0;

  const client = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filtros[col] = val;
          return chain;
        },
        in: () => chain,
        order: async () => {
          chamadas.push({ tabela, op: "list", filtros });
          if (tabela === "automation_rules") {
            chamadasAutomationRules += 1;
            return { data: opts.rules, error: null };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          chamadas.push({ tabela, op: "maybeSingle", filtros });
          if (tabela === "agent_inbox_items") {
            return { data: opts.inboxJaAberto ? { id: "inbox-existente" } : null, error: null };
          }
          if (tabela === "automation_rules") {
            // segunda+ chamada em automation_rules é o lookup de run_count por id
            return { data: { run_count: 0 }, error: null };
          }
          return { data: null, error: null };
        },
        insert(v: Record<string, unknown> | Record<string, unknown>[]) {
          chamadas.push({ tabela, op: "insert", valores: Array.isArray(v) ? v[0] : v, filtros });
          return {
            select: () => ({
              maybeSingle: async () => ({ data: { id: "run-1" }, error: null }),
            }),
          };
        },
        update(v: Record<string, unknown>) {
          chamadas.push({ tabela, op: "update", valores: v, filtros });
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
      void chamadasAutomationRules;
      return chain;
    },
  } as unknown as SupabaseClient;

  return { client, chamadas };
}

function rowDoEvento(): EventRow {
  return {
    id: "event-1",
    organization_id: "org-1",
    event_type: "lead.tag_added",
    entity_kind: "crm_lead",
    entity_id: null, // sem entity_id: buildContext não bate em crm_leads, contexto fica mínimo
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-10-02T12:00:00.000Z",
  };
}

describe("runAutomationForEvent — visibilidade de falha", () => {
  beforeEach(() => {
    executeAction.mockReset();
  });

  it("⭐ ação falha: abre aviso na Central com severidade critical, kind automation_rule_failed", async () => {
    executeAction.mockResolvedValue({ type: "falha_sempre", status: "failed", error: "timeout" });
    const { client, chamadas } = adminDuble({
      rules: [{ id: "rule-1", name: "Notificar CRM externo", conditions: [], actions: [{ type: "falha_sempre" }] }],
    });

    const out = await runAutomationForEvent(client, rowDoEvento());

    expect(out).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" });
    const aviso = chamadas.find((c) => c.tabela === "agent_inbox_items" && c.op === "insert");
    expect(aviso).toBeDefined();
    expect(aviso!.valores).toMatchObject({
      organization_id: "org-1",
      kind: "automation_rule_failed",
      severity: "critical",
      ref_kind: "automation_rule",
      ref_id: "rule-1",
    });
  });

  it("todas as ações da regra funcionam: nenhum aviso na Central", async () => {
    executeAction.mockResolvedValue({ type: "sucesso_sempre", status: "success" });
    const { client, chamadas } = adminDuble({
      rules: [{ id: "rule-2", name: "Marcar tag", conditions: [], actions: [{ type: "sucesso_sempre" }] }],
    });

    await runAutomationForEvent(client, rowDoEvento());

    expect(chamadas.some((c) => c.tabela === "agent_inbox_items" && c.op === "insert")).toBe(false);
  });

  it("já existe aviso ABERTO pra esta regra: não abre um segundo (dedup por regra, não por evento)", async () => {
    executeAction.mockResolvedValue({ type: "falha_sempre", status: "failed", error: "timeout" });
    const { client, chamadas } = adminDuble({
      rules: [{ id: "rule-1", name: "Notificar CRM externo", conditions: [], actions: [{ type: "falha_sempre" }] }],
      inboxJaAberto: true,
    });

    await runAutomationForEvent(client, rowDoEvento());

    expect(chamadas.some((c) => c.tabela === "agent_inbox_items" && c.op === "insert")).toBe(false);
  });
});
