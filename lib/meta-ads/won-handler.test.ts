import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { handleLeadWonForMetaCapi, META_CAPI_PURCHASE_CONSUMER_KEY } from "./won-handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

/**
 * Achado ao vivo (RevitaFio Mossoró): 1 de 14 vendas tinha `value_cents` nulo
 * e ainda assim tentava mandar Purchase pro Meta — que EXIGE moeda nesse
 * evento padrão e recusava o envio inteiro (subcode 2804010). O que se guarda
 * aqui é que o handler nem tenta: um lead fechado sem valor some ANTES de
 * qualquer chamada de rede, sem consultar credencial nem gravar log de falha
 * — o dado que falta é no lead, não no envio.
 */

type Linha = Record<string, unknown>;

function adminDuble(tabelas: Record<string, Linha[]>) {
  const chamadas: string[] = [];
  const client = {
    from(tabela: string) {
      chamadas.push(tabela);
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
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, chamadas };
}

function rowDoWon(entityId: string): EventRow {
  return {
    id: "event-1",
    organization_id: "org-1",
    event_type: "lead.won",
    entity_kind: "lead",
    entity_id: entityId,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-09-30T12:00:00.000Z",
  };
}

describe("handleLeadWonForMetaCapi", () => {
  it("⭐ lead fechado SEM valor: skip antes de qualquer chamada de rede — nem consulta credencial", async () => {
    const { client, chamadas } = adminDuble({
      crm_leads: [{ id: "lead-1", organization_id: "org-1", value_cents: null, currency: null, contact_id: null }],
    });

    const out = await handleLeadWonForMetaCapi(client, rowDoWon("lead-1"));

    expect(out).toEqual({ consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "skipped", detail: "no_value" });
    expect(chamadas).not.toContain("tenant_meta_ads_credentials");
    expect(chamadas).not.toContain("meta_capi_send_log");
  });

  it("⭐ lead fechado com moeda mas SEM valor (value_cents null): mesmo skip — os dois precisam estar presentes", async () => {
    const { client } = adminDuble({
      crm_leads: [{ id: "lead-1", organization_id: "org-1", value_cents: null, currency: "BRL", contact_id: null }],
    });

    const out = await handleLeadWonForMetaCapi(client, rowDoWon("lead-1"));
    expect(out).toEqual({ consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "skipped", detail: "no_value" });
  });

  it("nenhum lead encontrado pro evento: skip, detail no_lead", async () => {
    const { client } = adminDuble({ crm_leads: [] });
    const out = await handleLeadWonForMetaCapi(client, rowDoWon("lead-inexistente"));
    expect(out).toEqual({ consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "skipped", detail: "no_lead" });
  });

  it("lead com valor e moeda, mas org sem Meta Ads conectado: segue até sendMetaCapiEvent, que pula por falta de credencial — status final ok", async () => {
    const { client } = adminDuble({
      crm_leads: [
        {
          id: "lead-1",
          organization_id: "org-1",
          value_cents: 20000,
          currency: "BRL",
          contact_id: null,
          closed_at: "2026-09-30T12:00:00.000Z",
          source_metadata: {},
        },
      ],
      tenant_meta_ads_credentials: [],
    });

    const out = await handleLeadWonForMetaCapi(client, rowDoWon("lead-1"));
    expect(out).toEqual({ consumer_key: META_CAPI_PURCHASE_CONSUMER_KEY, status: "ok" });
  });
});
