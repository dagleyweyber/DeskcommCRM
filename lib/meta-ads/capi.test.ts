import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildCapiPayload } from "./capi";

const BASE = {
  eventName: "Purchase",
  eventId: "evt-1",
  eventTimeSeconds: 1_700_000_000,
  valueCents: 150_000,
  currency: "BRL",
  phone: "+55 31 99887-7665",
};

describe("buildCapiPayload", () => {
  it("⭐ ctwa_clid presente → action_source business_messaging, ctwa_clid em user_data", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "AbCdEf123", ad_click_id_type: "ctwa_clid" },
    });
    expect(p.action_source).toBe("business_messaging");
    expect(p.messaging_channel).toBe("whatsapp");
    expect(p.user_data.ctwa_clid).toBe("AbCdEf123");
  });

  it("⭐ ctwa_clid + pageId cacheado → user_data.page_id preenchido (sem ele a Meta rejeita business_messaging, subcode 2804116)", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "AbCdEf123", ad_click_id_type: "ctwa_clid" },
      pageId: "113751265048315",
    });
    expect(p.user_data.page_id).toBe("113751265048315");
  });

  it("ctwa_clid sem pageId cacheado (anúncio ainda não resolvido) → user_data.page_id ausente, não quebra", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "AbCdEf123", ad_click_id_type: "ctwa_clid" },
    });
    expect(p.user_data.page_id).toBeUndefined();
  });

  it("pageId presente mas SEM ctwa_clid (action_source website) não vaza pra user_data — page_id é só do ramo business_messaging", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { fbc: "fb.1.111.222" },
      pageId: "113751265048315",
    });
    expect(p.user_data.page_id).toBeUndefined();
  });

  it("⭐ sem ctwa_clid mas com fbc/fbp → action_source website, campos passam direto", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { fbc: "fb.1.111.222", fbp: "fb.1.333.444" },
    });
    expect(p.action_source).toBe("website");
    expect(p.messaging_channel).toBeUndefined();
    expect(p.user_data.fbc).toBe("fb.1.111.222");
    expect(p.user_data.fbp).toBe("fb.1.333.444");
  });

  it("fbclid sozinho (sem fbc) vira fbc sintético no formato fb.1.<time>.<fbclid>", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: { fbclid: "IwAR123" } });
    expect(p.action_source).toBe("website");
    expect(p.user_data.fbc).toBe(`fb.1.${BASE.eventTimeSeconds}.IwAR123`);
  });

  it("⭐ sem nenhuma atribuição → action_source system_generated, só telefone", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: {} });
    expect(p.action_source).toBe("system_generated");
    expect(p.user_data.ctwa_clid).toBeUndefined();
    expect(p.user_data.fbc).toBeUndefined();
    expect(p.user_data.ph).toBeDefined();
  });

  it("sourceMetadata null/ausente não quebra — mesmo resultado de {}", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: null });
    expect(p.action_source).toBe("system_generated");
  });

  it("telefone vira SHA-256 dos dígitos, sem '+' nem espaços — determinístico", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: {} });
    const esperado = createHash("sha256").update("5531998877665").digest("hex");
    expect(p.user_data.ph).toEqual([esperado]);
  });

  it("sem telefone, user_data.ph fica ausente (não hasheia string vazia)", () => {
    const p = buildCapiPayload({ ...BASE, phone: null, sourceMetadata: {} });
    expect(p.user_data.ph).toBeUndefined();
  });

  it("event_name/event_id/event_time vêm direto do input", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: {} });
    expect(p.event_name).toBe("Purchase");
    expect(p.event_id).toBe("evt-1");
    expect(p.event_time).toBe(1_700_000_000);
  });

  it("custom_data.value em REAIS (não centavos) — value_cents / 100", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: {} });
    expect(p.custom_data).toEqual({ value: 1500, currency: "BRL" });
  });

  it("sem value_cents ou sem currency, custom_data fica ausente (nunca meio-preenchido)", () => {
    const semValor = buildCapiPayload({ ...BASE, valueCents: null, sourceMetadata: {} });
    expect(semValor.custom_data).toBeUndefined();
    const semMoeda = buildCapiPayload({ ...BASE, currency: null, sourceMetadata: {} });
    expect(semMoeda.custom_data).toBeUndefined();
  });

  it("ad_click_id_type diferente de 'ctwa_clid' não ativa o ramo business_messaging", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "algo", ad_click_id_type: "outro_tipo" },
    });
    expect(p.action_source).toBe("system_generated");
  });
});
