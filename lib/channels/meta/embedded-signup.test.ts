import { describe, expect, it, vi } from "vitest";

import {
  exchangeEmbeddedCode,
  numerosDoAppNaWaba,
  subscribeWabaComOverride,
  wabaIdsDoToken,
} from "./embedded-signup";
import { origemDaMeta } from "./embedded-popup";

function resposta(corpo: unknown, ok = true, status = ok ? 200 : 400) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => corpo }) as unknown as typeof fetch;
}

describe("exchangeEmbeddedCode", () => {
  it("manda client_id/secret/code por query e SEM redirect_uri", async () => {
    const f = resposta({ access_token: "tok" });
    const r = await exchangeEmbeddedCode({ code: "c", appId: "A", appSecret: "S", fetchImpl: f });
    expect(r).toEqual({ ok: true, token: "tok" });
    const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain("/oauth/access_token?");
    expect(url).toContain("client_id=A");
    expect(url).toContain("code=c");
    expect(url).not.toContain("redirect_uri");
  });

  it("erro da Meta devolve o motivo; resposta sem token também falha", async () => {
    const a = await exchangeEmbeddedCode({
      code: "c", appId: "A", appSecret: "S",
      fetchImpl: resposta({ error: { message: "code expired" } }, false),
    });
    expect(a).toEqual({ ok: false, motivo: "code expired" });
    const b = await exchangeEmbeddedCode({ code: "c", appId: "A", appSecret: "S", fetchImpl: resposta({}) });
    expect(b.ok).toBe(false);
  });
});

describe("wabaIdsDoToken — a quem o token dá acesso, segundo a Meta", () => {
  it("junta só o escopo de gestão do WhatsApp e devolve o app dono do token", async () => {
    const f = resposta({
      data: {
        is_valid: true,
        app_id: "A",
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: ["W1", "W2"] },
          { scope: "whatsapp_business_messaging", target_ids: ["W9"] },
          { scope: "business_management", target_ids: ["B1"] },
        ],
      },
    });
    const r = await wabaIdsDoToken({ token: "t", appId: "A", appSecret: "S", fetchImpl: f });
    expect(r).toEqual({ ok: true, wabaIds: ["W1", "W2"], appIdDoToken: "A" });
    // token de app (app_id|secret) como access_token da inspeção
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      "access_token=A%7CS",
    );
  });

  it("token inválido falha", async () => {
    const r = await wabaIdsDoToken({
      token: "t", appId: "A", appSecret: "S", fetchImpl: resposta({ data: { is_valid: false } }),
    });
    expect(r.ok).toBe(false);
  });
});

describe("numerosDoAppNaWaba", () => {
  it("só devolve números que estão no app WhatsApp Business", async () => {
    const r = await numerosDoAppNaWaba({
      wabaId: "W", token: "t",
      fetchImpl: resposta({ data: [{ id: "1", is_on_biz_app: true }, { id: "2", is_on_biz_app: false }, { id: "3" }] }),
    });
    expect(r).toEqual({ ok: true, phoneNumberIds: ["1"] });
  });
});

describe("subscribeWabaComOverride", () => {
  it("POST com override_callback_uri + verify_token em JSON e Bearer", async () => {
    const f = resposta({ success: true });
    const r = await subscribeWabaComOverride({
      wabaId: "W", token: "t", callbackUri: "https://x.test/api/v1/webhooks/meta/abc", verifyToken: "v", fetchImpl: f,
    });
    expect(r.ok).toBe(true);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("/W/subscribed_apps");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer t");
    expect(JSON.parse(init.body)).toEqual({
      override_callback_uri: "https://x.test/api/v1/webhooks/meta/abc",
      verify_token: "v",
    });
  });

  it("URL acima de 200 caracteres é recusada ANTES de chamar a Meta", async () => {
    const f = resposta({ success: true });
    const r = await subscribeWabaComOverride({
      wabaId: "W", token: "t", callbackUri: `https://x.test/${"a".repeat(200)}`, verifyToken: "v", fetchImpl: f,
    });
    expect(r).toEqual({ ok: false, motivo: "callback_uri_maior_que_200_caracteres" });
    expect(f).not.toHaveBeenCalled();
  });

  it("a URL real de sessão (token de 48 hex) cabe no limite", () => {
    const uri = `https://crm-da-clinica.exemplo.com.br/api/v1/webhooks/meta/${"a".repeat(48)}`;
    expect(uri.length).toBeLessThanOrEqual(200);
  });
});

describe("origemDaMeta — quem pode nos mandar o postMessage", () => {
  it("aceita facebook.com e subdomínios", () => {
    expect(origemDaMeta("https://www.facebook.com")).toBe(true);
    expect(origemDaMeta("https://business.facebook.com")).toBe(true);
    expect(origemDaMeta("https://facebook.com")).toBe(true);
  });
  it("recusa domínio que apenas TERMINA com o texto, e origens estranhas", () => {
    expect(origemDaMeta("https://evilfacebook.com")).toBe(false);
    expect(origemDaMeta("https://facebook.com.evil.test")).toBe(false);
    expect(origemDaMeta("null")).toBe(false);
    expect(origemDaMeta("")).toBe(false);
  });
});
