import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildCapiPayload, nomeDoEventoPara } from "./capi";

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

  it("⭐ ctwa_clid + whatsappBusinessAccountId → user_data.whatsapp_business_account_id preenchido (page_id sozinho não bastou — subcode 2804131 achado ao vivo)", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "AbCdEf123", ad_click_id_type: "ctwa_clid" },
      pageId: "113751265048315",
      whatsappBusinessAccountId: "2122990258423751",
    });
    expect(p.user_data.page_id).toBe("113751265048315");
    expect(p.user_data.whatsapp_business_account_id).toBe("2122990258423751");
  });

  it("whatsappBusinessAccountId presente mas SEM ctwa_clid (action_source website) não vaza pra user_data", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { fbc: "fb.1.111.222" },
      whatsappBusinessAccountId: "2122990258423751",
    });
    expect(p.user_data.whatsapp_business_account_id).toBeUndefined();
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

  it("⭐ sem ctwa_clid, com fbc/fbp E navegador → action_source website, com client_user_agent e event_source_url", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: {
        fbc: "fb.1.111.222",
        fbp: "fb.1.333.444",
        client_user_agent: "Mozilla/5.0",
        landing_url: "https://lp.exemplo/oferta",
      },
    });
    expect(p.action_source).toBe("website");
    expect(p.messaging_channel).toBeUndefined();
    expect(p.user_data.fbc).toBe("fb.1.111.222");
    expect(p.user_data.fbp).toBe("fb.1.333.444");
    expect(p.user_data.client_user_agent).toBe("Mozilla/5.0");
    expect(p.event_source_url).toBe("https://lp.exemplo/oferta");
  });

  it("⭐ fbc/fbp SEM o navegador do visitante → system_generated (site exige client_user_agent), mantendo fbc/fbp", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: { fbc: "fb.1.111.222", fbp: "fb.1.333.444" } });
    expect(p.action_source).toBe("system_generated");
    expect(p.user_data.fbc).toBe("fb.1.111.222");
    expect(p.user_data.client_user_agent).toBeUndefined();
    expect(p.event_source_url).toBeUndefined();
  });

  it("⭐ fbclid sozinho vira fbc em MILISSEGUNDOS (formato fb.1.<ms>.<fbclid>), não em segundos", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: { fbclid: "IwAR123" } });
    expect(p.user_data.fbc).toBe(`fb.1.${BASE.eventTimeSeconds * 1000}.IwAR123`);
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

  it("⭐ 'Lead' em conversa de WhatsApp sai como 'LeadSubmitted' (a Meta recusa 'Lead' em business_messaging — subcode 2804066)", () => {
    const p = buildCapiPayload({
      ...BASE,
      eventName: "Lead",
      sourceMetadata: { ad_click_id: "AbC", ad_click_id_type: "ctwa_clid" },
    });
    expect(p.action_source).toBe("business_messaging");
    expect(p.event_name).toBe("LeadSubmitted");
  });

  it("'Lead' fora de conversa de WhatsApp continua 'Lead'", () => {
    expect(buildCapiPayload({ ...BASE, eventName: "Lead", sourceMetadata: {} }).event_name).toBe("Lead");
    expect(nomeDoEventoPara("website", "Lead")).toBe("Lead");
    expect(nomeDoEventoPara("business_messaging", "Purchase")).toBe("Purchase");
  });

  it("⭐ o ponto de contato (Fase 1) tem precedência: fbc gravado no clique e navegador do visitante", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { fbclid: "VELHO" },
      atribuicao: {
        clickIdType: "fbclid",
        clickId: "IwAR_novo",
        fbc: null,
        fbp: "fb.1.1.2",
        clientUserAgent: "Mozilla/5.0 (LP)",
        eventSourceUrl: "https://lp.exemplo/",
        clickTimeMs: 1_761_566_400_123,
      },
    });
    expect(p.action_source).toBe("website");
    expect(p.user_data.fbc).toBe("fb.1.1761566400123.IwAR_novo");
    expect(p.user_data.client_user_agent).toBe("Mozilla/5.0 (LP)");
    expect(p.event_source_url).toBe("https://lp.exemplo/");
  });

  it("⭐ e-mail e id do contato entram hasheados (SHA-256, e-mail normalizado) fora do ramo de mensagem", () => {
    const p = buildCapiPayload({ ...BASE, sourceMetadata: {}, email: "  Ana@Exemplo.COM ", externalId: "contato-1" });
    expect(p.user_data.em).toEqual([createHash("sha256").update("ana@exemplo.com").digest("hex")]);
    expect(p.user_data.external_id).toEqual([createHash("sha256").update("contato-1").digest("hex")]);
  });

  it("no ramo de mensagem (ctwa_clid) não manda e-mail nem id externo — campo a mais é risco de recusa", () => {
    const p = buildCapiPayload({
      ...BASE,
      sourceMetadata: { ad_click_id: "AbC", ad_click_id_type: "ctwa_clid" },
      email: "ana@exemplo.com",
      externalId: "contato-1",
    });
    expect(p.user_data.em).toBeUndefined();
    expect(p.user_data.external_id).toBeUndefined();
  });
});
