import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lead qualificado (pedido do usuário, RevitaFio Mossoró): entrar numa etapa
 * marcada com `meta_capi_event_name` dispara aquele evento padrão do Meta.
 * Mecanismo genérico — não hardcoded pra "Avaliação Agendada"/"Schedule" — o
 * que se guarda é que o handler lê a marcação da etapa de DESTINO e só
 * dispara quando ela existe; o nome do evento em si (`buildCapiPayload`,
 * `capi.test.ts`) e o reenvio em falha (`send-log.test.ts`) já têm teste
 * próprio, não repetido aqui.
 */
const sendMetaCapiEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/meta-ads/send", () => ({ sendMetaCapiEvent }));

import { handleStageChangedForMetaCapi, META_CAPI_STAGE_CONSUMER_KEY } from "./schedule-handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

type Linha = Record<string, unknown>;

function adminDuble(tabelas: Record<string, Linha[]>) {
  const client = {
    from(tabela: string) {
      const linhas = tabelas[tabela] ?? [];
      const filtros: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filtros[col] = val;
          return chain;
        },
        maybeSingle: async () => {
          const achado = linhas.find((l) => Object.entries(filtros).every(([k, v]) => l[k] === v));
          return { data: achado ?? null, error: null };
        },
        // `recordCapiSendResult` grava em meta_capi_send_log/agent_inbox_items
        // depois do envio — este teste não verifica esses inserts (é o
        // assunto de send-log.test.ts), só precisa não quebrar.
        insert: async () => ({ error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return client;
}

function rowDeMudancaDeEtapa(toStageId: string | undefined, entityId = "lead-1"): EventRow {
  return {
    id: "event-1",
    organization_id: "org-1",
    event_type: "lead.stage_changed",
    entity_kind: "crm_lead",
    entity_id: entityId,
    payload: toStageId ? { to_stage_id: toStageId } : {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-09-30T12:00:00.000Z",
  };
}

describe("handleStageChangedForMetaCapi", () => {
  beforeEach(() => {
    sendMetaCapiEvent.mockReset();
  });

  it("⭐ etapa de destino sem meta_capi_event_name: skip, nunca chama sendMetaCapiEvent", async () => {
    const admin = adminDuble({
      crm_stages: [{ id: "stage-1", organization_id: "org-1", meta_capi_event_name: null }],
    });

    const out = await handleStageChangedForMetaCapi(admin, rowDeMudancaDeEtapa("stage-1"));

    expect(out).toEqual({ consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "stage_sem_evento" });
    expect(sendMetaCapiEvent).not.toHaveBeenCalled();
  });

  it("evento sem to_stage_id no payload (não deveria acontecer, mas não quebra): skip", async () => {
    const admin = adminDuble({});
    const out = await handleStageChangedForMetaCapi(admin, rowDeMudancaDeEtapa(undefined));
    expect(out).toEqual({ consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "no_to_stage" });
  });

  it("⭐ etapa marcada com Schedule: chama sendMetaCapiEvent com esse nome, SEM valueCents/currency", async () => {
    sendMetaCapiEvent.mockResolvedValue({ status: "sent" });
    const admin = adminDuble({
      crm_stages: [{ id: "stage-agendada", organization_id: "org-1", meta_capi_event_name: "Schedule" }],
      crm_leads: [{ id: "lead-1", organization_id: "org-1", contact_id: null, source_metadata: {} }],
    });

    const out = await handleStageChangedForMetaCapi(admin, rowDeMudancaDeEtapa("stage-agendada"));

    expect(sendMetaCapiEvent).toHaveBeenCalledTimes(1);
    const [, , input] = sendMetaCapiEvent.mock.calls[0]!;
    expect(input.eventName).toBe("Schedule");
    expect(input).not.toHaveProperty("valueCents");
    expect(input).not.toHaveProperty("currency");
    expect(out).toEqual({ consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "ok" });
  });

  it("lead da etapa não encontrado: skip, detail no_lead, nunca chama sendMetaCapiEvent", async () => {
    const admin = adminDuble({
      crm_stages: [{ id: "stage-agendada", organization_id: "org-1", meta_capi_event_name: "Schedule" }],
      crm_leads: [],
    });

    const out = await handleStageChangedForMetaCapi(admin, rowDeMudancaDeEtapa("stage-agendada"));
    expect(out).toEqual({ consumer_key: META_CAPI_STAGE_CONSUMER_KEY, status: "skipped", detail: "no_lead" });
    expect(sendMetaCapiEvent).not.toHaveBeenCalled();
  });
});
