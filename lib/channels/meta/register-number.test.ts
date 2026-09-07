import { describe, expect, it, vi } from "vitest";

import { registerMetaPhoneNumber } from "./register-number";

/**
 * Achado ao vivo: número conectado via Business Manager (não pelo assistente
 * padrão) fica em `133010 Account not registered` até esta chamada rodar uma
 * vez. Congela o contrato pra não regredir de volta ao "conectou mas não
 * manda mensagem".
 */
describe("registerMetaPhoneNumber", () => {
  it("⭐ sucesso — envia messaging_product e um pin de 6 dígitos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const r = await registerMetaPhoneNumber({
      phoneNumberId: "123",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/123/register");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as { messaging_product: string; pin: string };
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.pin).toMatch(/^\d{6}$/);
  });

  it("erro da Graph API vira motivo legível, não exceção", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "(#133010) Account not registered" } }),
    });

    const r = await registerMetaPhoneNumber({
      phoneNumberId: "123",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("133010");
  });

  it("rede indisponível não lança — devolve motivo", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));

    const r = await registerMetaPhoneNumber({
      phoneNumberId: "123",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("rede indisponível");
  });
});
