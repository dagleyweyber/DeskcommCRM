import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Achado ao vivo (RevitaFio Mossoró, depurando 8 Purchase falhados de 14):
 * o erro da Meta vinha cortado em 300 caracteres — exatamente onde a frase
 * que explica a causa ("nenhuma Página associada...") começa. O que se
 * guarda aqui é que o corpo do erro sobrevive muito além disso, pra uma
 * investigação futura não bater na mesma parede.
 */
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "token-de-acesso",
}));

import { sendMetaCapiEvent } from "./send";

function adminDuble() {
  return {
    from(tabela: string) {
      if (tabela === "tenant_meta_ads_credentials") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { access_token_encrypted: "\\xdeadbeef", dataset_id: "1347079350614883" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela não modelada no double: ${tabela}`);
    },
  } as unknown as SupabaseClient;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("sendMetaCapiEvent", () => {
  it("⭐ erro da Meta não é cortado em 300 caracteres — a causa real sobrevive no log", async () => {
    // Padding bem além dos 300 chars antigos, de propósito — a frase-alvo não
    // pode sobreviver por acidente de contagem; ela só aparece se o corte for
    // generoso o bastante pra valer a pena.
    const mensagemLonga =
      "x".repeat(400) + " Conecte a Página ao conjunto de dados no Gerenciador de Eventos.";
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "Invalid parameter",
            type: "OAuthException",
            code: 100,
            error_subcode: 2804131,
            error_user_title: "Evento de mensagem nenhuma Página associada ao conjunto de dados",
            error_user_msg: mensagemLonga,
          },
        },
        400,
      ),
    );

    const result = await sendMetaCapiEvent(
      adminDuble(),
      "org-1",
      { eventName: "Purchase", eventId: "event-1", eventTimeSeconds: 1234567890, phone: "+5511999990000" },
      { fetchImpl },
    );

    expect(result.status).toBe("failed");
    // a frase que explica a causa ficava DEPOIS do corte de 300 chars — se
    // reaparecer aqui, a correção está de pé.
    expect(result.error).toContain("Conecte a Página ao conjunto de dados");
  });

  it("resposta ok: status sent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ events_received: 1 }, 200));
    const result = await sendMetaCapiEvent(
      adminDuble(),
      "org-1",
      { eventName: "Schedule", eventId: "event-2", eventTimeSeconds: 1234567890 },
      { fetchImpl },
    );
    expect(result).toEqual({ status: "sent" });
  });
});
