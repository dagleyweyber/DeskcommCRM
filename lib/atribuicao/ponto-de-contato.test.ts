import { describe, expect, it } from "vitest";

import { mapInboundPayload } from "@/lib/webhooks/inbound";
import {
  CANAL,
  VIA,
  pontoDeContatoDaVisita,
  pontoDoAnuncioWhatsApp,
  pontosDaLandingPage,
  valorLimpo,
} from "./ponto-de-contato";
import { linhaDoPontoDeContato } from "./registrar";

describe("pontoDeContatoDaVisita — Meta", () => {
  it("⭐ parâmetros recomendados da Meta: campanha, conjunto e anúncio com id e nome", () => {
    const p = pontoDeContatoDaVisita({
      utm_source: "facebook",
      utm_medium: "paid",
      utm_campaign: "Black Friday",
      utm_term: "Mulheres 25-45",
      utm_content: "Video depoimento",
      campaign_id: "120211",
      adset_id: "120222",
      ad_id: "120233",
      fbclid: "IwAR_ABC",
    })!;
    expect(p.canal).toBe(CANAL.META_ADS);
    expect(p.via).toBe(VIA.LANDING_PAGE);
    expect([p.campaignId, p.adsetId, p.adId]).toEqual(["120211", "120222", "120233"]);
    expect([p.campaignName, p.adsetName, p.adName]).toEqual(["Black Friday", "Mulheres 25-45", "Video depoimento"]);
    expect(p.clickIdType).toBe("fbclid");
    expect(p.fbc).toMatch(/^fb\.1\.\d{13}\.IwAR_ABC$/);
  });

  it("⭐ ids postos nas UTMs (utm_campaign numérico) são reconhecidos como ids", () => {
    const p = pontoDeContatoDaVisita({
      utm_source: "fb",
      utm_campaign: "1202113344",
      utm_term: "1202223344",
      utm_content: "1202333344",
    })!;
    expect([p.campaignId, p.adsetId, p.adId]).toEqual(["1202113344", "1202223344", "1202333344"]);
    expect([p.campaignName, p.adsetName, p.adName]).toEqual([null, null, null]);
  });

  it("⭐ fbc do cookie do Pixel tem precedência sobre o montado a partir do fbclid", () => {
    const p = pontoDeContatoDaVisita({ fbclid: "X", fbc: "fb.1.1700000000000.X" })!;
    expect(p.fbc).toBe("fb.1.1700000000000.X");
  });

  it("fbc montado no servidor usa a hora do CLIQUE em milissegundos, quando conhecida", () => {
    const p = pontoDeContatoDaVisita({ fbclid: "Y" }, { occurredAt: "2026-10-01T12:00:00.000Z" })!;
    expect(p.fbc).toBe(`fb.1.${Date.parse("2026-10-01T12:00:00.000Z")}.Y`);
  });
});

describe("pontoDeContatoDaVisita — Google", () => {
  it("⭐ gclid + ValueTrack: campanha, grupo de anúncios, anúncio (creative) e palavra-chave", () => {
    const p = pontoDeContatoDaVisita({
      gclid: "Cj0K_XYZ",
      campaign_id: "987654321",
      adgroup_id: "112233445",
      creative: "667788990",
      keyword: "depilacao a laser recife",
    })!;
    expect(p.canal).toBe(CANAL.GOOGLE_ADS);
    expect(p.clickIdType).toBe("gclid");
    expect([p.campaignId, p.adsetId, p.adId]).toEqual(["987654321", "112233445", "667788990"]);
    expect(p.keyword).toBe("depilacao a laser recife");
  });

  it("gbraid/wbraid (iOS) também identificam o Google", () => {
    expect(pontoDeContatoDaVisita({ gbraid: "0AAA" })!.clickIdType).toBe("gbraid");
    expect(pontoDeContatoDaVisita({ wbraid: "0BBB" })!.canal).toBe(CANAL.GOOGLE_ADS);
  });

  it("utm_source=google sem gclid ainda é Google, e utm_term vira palavra-chave", () => {
    const p = pontoDeContatoDaVisita({ utm_source: "google", utm_medium: "cpc", utm_term: "clinica estetica" })!;
    expect(p.canal).toBe(CANAL.GOOGLE_ADS);
    expect(p.keyword).toBe("clinica estetica");
    expect(p.adsetName).toBeNull();
  });

  it("parâmetro automático do Google (gad_campaignid) vira id de campanha", () => {
    const p = pontoDeContatoDaVisita({ gad_source: "1", gad_campaignid: "22334455" })!;
    expect(p.canal).toBe(CANAL.GOOGLE_ADS);
    expect(p.campaignId).toBe("22334455");
  });
});

describe("pontoDeContatoDaVisita — bordas", () => {
  it("⭐ visita direta (sem nenhum sinal de origem) não vira ponto de contato inventado", () => {
    expect(pontoDeContatoDaVisita({ nome: "Ana", landing_url: "https://lp.exemplo/" })).toBeNull();
  });

  it("⭐ parâmetro dinâmico não substituído é descartado", () => {
    const p = pontoDeContatoDaVisita({ utm_source: "facebook", ad_id: "{{ad.id}}", campaign_id: "{campaignid}" })!;
    expect(p.adId).toBeNull();
    expect(p.campaignId).toBeNull();
  });

  it("origem desconhecida vira 'outro', preservando a UTM", () => {
    const p = pontoDeContatoDaVisita({ utm_source: "newsletter", utm_campaign: "outubro" })!;
    expect(p.canal).toBe(CANAL.OUTRO);
    expect(p.utmSource).toBe("newsletter");
    expect(p.campaignName).toBe("outubro");
  });

  it("chaves em maiúscula casam", () => {
    expect(pontoDeContatoDaVisita({ UTM_SOURCE: "Instagram" })!.canal).toBe(CANAL.META_ADS);
  });

  it("valorLimpo corta valores enormes e recusa vazio", () => {
    expect(valorLimpo("  ")).toBeNull();
    expect(valorLimpo("x".repeat(5000))!.length).toBe(1000);
    expect(valorLimpo(123456)).toBe("123456");
  });
});

describe("pontosDaLandingPage — primeiro e último toque", () => {
  it("⭐ primeiro toque diferente vira um ponto próprio, em ordem cronológica", () => {
    const pontos = pontosDaLandingPage(
      { utm_source: "google", gclid: "G1", campaign_id: "222222" },
      JSON.stringify({ ts: "2026-10-01T10:00:00.000Z", utm_source: "facebook", campaign_id: "111111" }),
    );
    expect(pontos.map((p) => [p.canal, p.campaignId])).toEqual([
      [CANAL.META_ADS, "111111"],
      [CANAL.GOOGLE_ADS, "222222"],
    ]);
    expect(pontos[0]!.occurredAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("primeiro igual ao último → um ponto só", () => {
    const iguais = { utm_source: "facebook", campaign_id: "111111" };
    expect(pontosDaLandingPage(iguais, JSON.stringify({ ts: "2026-10-01T10:00:00Z", ...iguais }))).toHaveLength(1);
  });

  it("JSON do navegador quebrado não derruba: fica o último toque", () => {
    expect(pontosDaLandingPage({ utm_source: "facebook" }, "{quebrado")).toHaveLength(1);
  });

  it("sem nada → nenhum ponto", () => {
    expect(pontosDaLandingPage({}, null)).toEqual([]);
  });
});

describe("pontoDoAnuncioWhatsApp", () => {
  it("⭐ clique no anúncio de WhatsApp: ctwa_clid + id do anúncio, canal Meta", () => {
    const p = pontoDoAnuncioWhatsApp({ clickId: "ARAkLk_x", sourceId: "120244", headline: "Avaliação grátis", sourceUrl: "https://fb.me/x" })!;
    expect(p.canal).toBe(CANAL.META_ADS);
    expect(p.via).toBe(VIA.ANUNCIO_WHATSAPP);
    expect(p.clickIdType).toBe("ctwa_clid");
    expect(p.adId).toBe("120244");
    expect(p.extras).toEqual({ ad_headline: "Avaliação grátis" });
  });

  it("sem clique e sem anúncio → nenhum ponto", () => {
    expect(pontoDoAnuncioWhatsApp({ headline: "x" })).toBeNull();
  });
});

describe("linhaDoPontoDeContato", () => {
  it("grava snake_case com organização, lead e contato; sem occurred_at quando é 'agora'", () => {
    const linha = linhaDoPontoDeContato(pontoDeContatoDaVisita({ utm_source: "google", gclid: "G" })!, {
      organizationId: "org",
      leadId: "lead",
      contactId: null,
    });
    expect(linha).toMatchObject({ organization_id: "org", lead_id: "lead", canal: "google_ads", click_id: "G" });
    expect("occurred_at" in linha).toBe(false);
  });
});

describe("mapInboundPayload — chaves de atribuição da landing page", () => {
  it("⭐ ids de campanha/conjunto/anúncio e dados do navegador vão para source_metadata, não para custom_fields", () => {
    const m = mapInboundPayload({
      nome: "Ana",
      telefone: "81999990000",
      campaign_id: "120211",
      adset_id: "120222",
      ad_id: "120233",
      gbraid: "0AAA",
      landing_url: "https://lp.exemplo/?utm_source=facebook",
      client_user_agent: "Mozilla/5.0",
      interesse: "Laser",
    });
    expect(m.source_metadata).toMatchObject({
      campaign_id: "120211",
      adset_id: "120222",
      ad_id: "120233",
      gbraid: "0AAA",
      client_user_agent: "Mozilla/5.0",
    });
    expect(m.custom_fields).toEqual({ interesse: "Laser" });
  });

  it("⭐ parâmetro dinâmico não substituído some dos dois lados", () => {
    const m = mapInboundPayload({ nome: "Ana", ad_id: "{{ad.id}}" });
    expect(m.source_metadata).toEqual({});
    expect(m.custom_fields).toEqual({});
  });

  it("⭐ dc_primeiro_contato sai separado, nunca em custom_fields nem source_metadata", () => {
    const m = mapInboundPayload({ nome: "Ana", dc_primeiro_contato: '{"utm_source":"facebook"}' });
    expect(m.primeiro_contato).toBe('{"utm_source":"facebook"}');
    expect(m.custom_fields).toEqual({});
    expect(m.source_metadata).toEqual({});
  });
});
