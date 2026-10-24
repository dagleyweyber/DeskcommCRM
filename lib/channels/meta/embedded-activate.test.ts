import { describe, expect, it, vi } from "vitest";

import { ativarCoexistencia } from "./embedded-activate";

/**
 * A regra deste arquivo nasceu de um incidente real: a assinatura da WABA falhou na
 * primeira conexão e, como o pedido de histórico (que a Meta aceita UMA vez) é feito
 * depois dela, o que importa travar é a ORDEM e o que NÃO é gasto quando falha.
 */
type Chamada = { url: string; init?: RequestInit };

function fetchFalso(respostas: Array<{ ok: boolean; corpo: unknown }>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[Math.min(i, respostas.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.corpo };
  });
  return { fn: fn as unknown as typeof fetch, chamadas };
}

const base = {
  wabaId: "W1",
  phoneNumberId: "PN1",
  token: "tok",
  callbackUri: "https://crm.test/api/v1/webhooks/meta/abc",
  verifyToken: "verify",
};

describe("ativarCoexistencia", () => {
  it("assina (2 chamadas) e SÓ ENTÃO pede agenda e histórico, nessa ordem", async () => {
    const { fn, chamadas } = fetchFalso([{ ok: true, corpo: { success: true, request_id: "R1" } }]);
    const r = await ativarCoexistencia({ ...base, fetchImpl: fn });

    expect(r.ok).toBe(true);
    const urls = chamadas.map((c) => c.url);
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("/W1/subscribed_apps");
    expect(urls[1]).toContain("/W1/subscribed_apps");
    expect(urls[2]).toContain("/PN1/smb_app_data");
    expect(urls[3]).toContain("/PN1/smb_app_data");
    expect(JSON.parse(String(chamadas[2]!.init!.body)).sync_type).toBe("smb_app_state_sync");
    expect(JSON.parse(String(chamadas[3]!.init!.body)).sync_type).toBe("history");
  });

  it("⭐ assinatura falhou → NENHUM pedido de histórico é feito (o pedido vale uma vez e fica guardado)", async () => {
    const { fn, chamadas } = fetchFalso([
      { ok: false, corpo: { error: { message: "(#100) Before override the current callback uri, your app must be subscribed" } } },
    ]);
    const r = await ativarCoexistencia({ ...base, fetchImpl: fn });

    expect(r).toMatchObject({ ok: false, etapa: "assinatura" });
    expect(chamadas.some((c) => c.url.includes("smb_app_data"))).toBe(false);
  });

  it("pedido de histórico recusado (já pedido antes) não derruba a ativação — volta no resultado", async () => {
    const { fn } = fetchFalso([
      { ok: true, corpo: { success: true } }, // assinatura simples
      { ok: true, corpo: { success: true } }, // override
      { ok: true, corpo: { success: true, request_id: "R-contatos" } }, // agenda
      { ok: false, corpo: { error: { message: "sync already requested" } } }, // histórico
    ]);
    const r = await ativarCoexistencia({ ...base, fetchImpl: fn });

    if (!r.ok) throw new Error("deveria ter ativado");
    expect(r.sync.smb_app_state_sync).toEqual({ ok: true, requestId: "R-contatos" });
    expect(r.sync.history).toEqual({ ok: false, motivo: "sync already requested" });
  });
});
