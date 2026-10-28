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
 *
 * Fase 2 do rastreamento (2026-10-28): recusa que a Meta marca como definitiva
 * (`is_transient: false`) NÃO é reenviada, vira UM aviso por motivo, e a conexão
 * deixa de mostrar "Conectado" — medido: 25 vendas da Caruaru recusadas por
 * configuração, 140 reenvios inúteis em 7 dias, e a tela dizendo "Conectado".
 */
interface Chamada {
  tabela: string;
  op: "insert" | "update" | "select";
  valores?: Record<string, unknown>;
  filtros?: Array<[string, unknown]>;
}

function clientDuble(opts: { avisoAberto?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      return {
        insert(v: Record<string, unknown>) {
          chamadas.push({ tabela, op: "insert", valores: v });
          return Promise.resolve({ error: null });
        },
        update(v: Record<string, unknown>) {
          const filtros: Array<[string, unknown]> = [];
          const cadeia = {
            eq(c: string, val: unknown) {
              filtros.push([c, val]);
              return cadeia;
            },
            in(c: string, val: unknown) {
              filtros.push([c, val]);
              chamadas.push({ tabela, op: "update", valores: v, filtros });
              return Promise.resolve({ error: null });
            },
          };
          return cadeia;
        },
        select() {
          const cadeia = {
            eq: () => cadeia,
            limit: () => cadeia,
            maybeSingle: () => {
              chamadas.push({ tabela, op: "select" });
              return Promise.resolve({ data: opts.avisoAberto ? { id: "aviso-1" } : null, error: null });
            },
          };
          return cadeia;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, chamadas };
}

const ERRO_2804131 =
  'http_400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2804131,"is_transient":false,"error_user_title":"Evento de mensagem nenhuma Página associada ao conjunto de dados","error_user_msg":"Para eventos de CTM e CTWA, a identificação do conjunto de dados é usada para enviar eventos à API de Conversões e deve ter uma Página associada"}}';

const inserts = (c: Chamada[], tabela: string) => c.filter((x) => x.op === "insert" && x.tabela === tabela);

describe("recordCapiSendResult", () => {
  it("⭐ envio bem-sucedido: status ok, uma linha em meta_capi_send_log, nenhum aviso — e a conexão volta a 'Conectado'", async () => {
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
    expect(inserts(chamadas, "meta_capi_send_log").map((c) => c.valores)).toEqual([
      { organization_id: "org-1", lead_id: "lead-1", event_name: "Purchase", status: "sent", meta_error: null },
    ]);
    expect(inserts(chamadas, "agent_inbox_items")).toHaveLength(0);
    const conexao = chamadas.find((c) => c.op === "update" && c.tabela === "tenant_meta_ads_credentials");
    expect(conexao?.valores).toEqual({ status: "healthy", last_error: null });
    expect(conexao?.filtros).toContainEqual(["organization_id", "org-1"]);
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
    expect(inserts(chamadas, "meta_capi_send_log")).toHaveLength(1);
    expect(inserts(chamadas, "agent_inbox_items")).toHaveLength(0);
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
    const [avisoCentral] = inserts(chamadas, "agent_inbox_items");
    expect(avisoCentral?.valores).toMatchObject({
      organization_id: "org-1",
      kind: "meta_capi_send_exhausted",
      severity: "critical",
      ref_kind: "crm_lead",
      ref_id: "lead-1",
    });
  });

  it("⭐ recusa DEFINITIVA da Meta (is_transient=false): não reenvia, a conexão vira 'Erro' com a instrução, e sai UM aviso por motivo", async () => {
    const { client, chamadas } = clientDuble();
    const out = await recordCapiSendResult(client, {
      consumerKey: "meta-capi-purchase",
      organizationId: "org-1",
      leadId: "lead-1",
      eventName: "Purchase",
      result: { status: "failed", error: ERRO_2804131 },
      attemptsSoFar: 0, // primeira tentativa: mesmo assim não volta para a fila
    });

    expect(out).toEqual({ consumer_key: "meta-capi-purchase", status: "skipped", detail: "meta_recusou:2804131" });

    const conexao = chamadas.find((c) => c.op === "update" && c.tabela === "tenant_meta_ads_credentials");
    expect(conexao?.valores?.status).toBe("error");
    expect(String(conexao?.valores?.last_error)).toMatch(/associe este conjunto de dados à Página/);

    const avisos = inserts(chamadas, "agent_inbox_items");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.valores).toMatchObject({ kind: "meta_capi_send_exhausted", ref_kind: "organization", ref_id: "org-1" });
    expect(String(avisos[0]!.valores!.body)).toMatch(/O que fazer/);
    // o JSON cru da Meta não vai para o aviso
    expect(String(avisos[0]!.valores!.body)).not.toContain("OAuthException");
  });

  it("⭐ segundo lead com o MESMO motivo, aviso ainda aberto: nenhum aviso novo (vinte avisos iguais escondem o que fazer)", async () => {
    const { client, chamadas } = clientDuble({ avisoAberto: true });
    await recordCapiSendResult(client, {
      consumerKey: "meta-capi-purchase",
      organizationId: "org-1",
      leadId: "lead-2",
      eventName: "Purchase",
      result: { status: "failed", error: ERRO_2804131 },
      attemptsSoFar: 0,
    });
    expect(inserts(chamadas, "agent_inbox_items")).toHaveLength(0);
    // o envio continua registrado — é dele que o painel de envios conta
    expect(inserts(chamadas, "meta_capi_send_log")).toHaveLength(1);
  });
});
