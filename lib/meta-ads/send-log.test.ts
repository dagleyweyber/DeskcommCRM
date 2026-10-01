import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordCapiSendResult } from "./send-log";
import { MAX_ATTEMPTS } from "@/lib/event-log/drain";

/**
 * Achado ao vivo (RevitaFio Mossoró): `handleLeadWonForMetaCapi` sempre
 * devolvia `status:"ok"` mesmo numa falha de envio — o reenvio com backoff
 * que `lib/event-log/drain.ts` já tem pronto nunca era acionado, e 8 de 14
 * tentativas de Purchase se perderam em silêncio. O que se guarda aqui é
 * exatamente essa troca: falha vira `status:"error"` (liga o reenvio), e só
 * quando a ÚLTIMA tentativa permitida ainda assim falha é que sai o aviso na
 * Central — porque depois dela não existe "próxima vez" pra esse evento.
 */
interface Chamada {
  tabela: string;
  valores: Record<string, unknown>;
}

function clientDuble() {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      return {
        insert(v: Record<string, unknown>) {
          chamadas.push({ tabela, valores: v });
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, chamadas };
}

describe("recordCapiSendResult", () => {
  it("⭐ envio bem-sucedido: status ok, uma linha em meta_capi_send_log, nenhum aviso na Central", async () => {
    const { client, chamadas } = clientDuble();
    const out = await recordCapiSendResult(client, {
      consumerKey: "teste",
      organizationId: "org-1",
      leadId: "lead-1",
      eventName: "Purchase",
      result: { status: "sent" },
      attemptsSoFar: 0,
    });

    expect(out).toEqual({ consumer_key: "teste", status: "ok" });
    expect(chamadas).toEqual([
      { tabela: "meta_capi_send_log", valores: { organization_id: "org-1", lead_id: "lead-1", event_name: "Purchase", status: "sent", meta_error: null } },
    ]);
  });

  it("⭐ 'skipped' (sem credencial/sem valor): status ok, SEM linha de log — não polui a tabela com não-tentativa", async () => {
    const { client, chamadas } = clientDuble();
    const out = await recordCapiSendResult(client, {
      consumerKey: "teste",
      organizationId: "org-1",
      leadId: "lead-1",
      eventName: "Purchase",
      result: { status: "skipped", error: "no_value" },
      attemptsSoFar: 0,
    });

    expect(out).toEqual({ consumer_key: "teste", status: "ok" });
    expect(chamadas).toHaveLength(0);
  });

  it("⭐ falha NÃO na última tentativa: status error (liga o reenvio do event_log), sem aviso na Central ainda", async () => {
    const { client, chamadas } = clientDuble();
    const out = await recordCapiSendResult(client, {
      consumerKey: "meta-capi-purchase",
      organizationId: "org-1",
      leadId: "lead-1",
      eventName: "Purchase",
      result: { status: "failed", error: "http_400: nenhuma Página associada" },
      attemptsSoFar: 0, // primeira tentativa — longe do limite
    });

    expect(out).toEqual({
      consumer_key: "meta-capi-purchase",
      status: "error",
      detail: "http_400: nenhuma Página associada",
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.tabela).toBe("meta_capi_send_log");
    expect(chamadas.some((c) => c.tabela === "agent_inbox_items")).toBe(false);
  });

  it(`⭐ falha NA ÚLTIMA tentativa (attemptsSoFar + 1 === MAX_ATTEMPTS=${MAX_ATTEMPTS}): grava o aviso na Central — depois disto o evento vira 'dead' e não chama este handler de novo`, async () => {
    const { client, chamadas } = clientDuble();
    const out = await recordCapiSendResult(client, {
      consumerKey: "meta-capi-purchase",
      organizationId: "org-1",
      leadId: "lead-1",
      eventName: "Purchase",
      result: { status: "failed", error: "http_400: erro final" },
      attemptsSoFar: MAX_ATTEMPTS - 1,
    });

    expect(out.status).toBe("error");
    const avisoCentral = chamadas.find((c) => c.tabela === "agent_inbox_items");
    expect(avisoCentral).toBeDefined();
    expect(avisoCentral!.valores).toMatchObject({
      organization_id: "org-1",
      kind: "meta_capi_send_exhausted",
      severity: "critical",
      ref_kind: "crm_lead",
      ref_id: "lead-1",
    });
  });
});
