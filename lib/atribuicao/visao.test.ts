import { describe, expect, it } from "vitest";

import { PARAMETROS_URL_GOOGLE, PARAMETROS_URL_META, scriptDeRastreio } from "./guia";
import { pontoDeContatoDaVisita } from "./ponto-de-contato";
import { montaAtribuicao, type LinhaDoPontoDeContato } from "./visao";

const base: Omit<LinhaDoPontoDeContato, "id" | "occurred_at"> = {
  canal: "meta_ads",
  via: "anuncio_whatsapp",
  click_id_type: "ctwa_clid",
  click_id: "ARAk_secreto",
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  campaign_id: null,
  campaign_name: null,
  adset_id: null,
  adset_name: null,
  ad_id: "120244",
  ad_name: null,
  keyword: null,
  landing_url: null,
  extras: { ad_headline: "Avaliação grátis" },
};

describe("montaAtribuicao", () => {
  it("⭐ anúncio da Meta ganha campanha/conjunto/anúncio resolvidos pela API", () => {
    const { pontos } = montaAtribuicao(
      [{ ...base, id: "1", occurred_at: "2026-10-01T10:00:00Z" }],
      [{ ad_id: "120244", ad_name: "Vídeo 1", adset_id: "120222", adset_name: "Mulheres 25-45", campaign_id: "120211", campaign_name: "Laser Outubro" }],
    );
    expect(pontos[0]).toMatchObject({
      campaign_name: "Laser Outubro",
      campaign_id: "120211",
      adset_name: "Mulheres 25-45",
      ad_name: "Vídeo 1",
      ad_headline: "Avaliação grátis",
      tem_clique: true,
    });
  });

  it("⭐ o identificador do clique NÃO vai para a tela (é dado de envio, não de leitura)", () => {
    const { pontos } = montaAtribuicao([{ ...base, id: "1", occurred_at: "2026-10-01T10:00:00Z" }], []);
    expect(JSON.stringify(pontos)).not.toContain("ARAk_secreto");
  });

  it("sem nome resolvido, fica o que veio na URL; Google nunca consulta a hierarquia da Meta", () => {
    const { pontos } = montaAtribuicao(
      [{ ...base, id: "2", canal: "google_ads", ad_id: "120244", campaign_name: "Busca Laser", occurred_at: "2026-10-01T10:00:00Z" }],
      [{ ad_id: "120244", ad_name: "NÃO", adset_id: null, adset_name: null, campaign_id: null, campaign_name: "NÃO" }],
    );
    expect(pontos[0]!.campaign_name).toBe("Busca Laser");
    expect(pontos[0]!.ad_name).toBeNull();
  });

  it("ordem cronológica: primeiro toque primeiro", () => {
    const { pontos } = montaAtribuicao(
      [
        { ...base, id: "tarde", occurred_at: "2026-10-02T10:00:00Z" },
        { ...base, id: "cedo", occurred_at: "2026-10-01T10:00:00Z" },
      ],
      [],
    );
    expect(pontos.map((p) => p.id)).toEqual(["cedo", "tarde"]);
  });
});

describe("guia de rastreamento", () => {
  it("⭐ o script aponta para o CRM e para o webhook desta fonte", () => {
    expect(scriptDeRastreio("https://crm.exemplo", "https://crm.exemplo/api/v1/webhooks/in/tok")).toBe(
      '<script src="https://crm.exemplo/rastreio.js" data-webhook="https://crm.exemplo/api/v1/webhooks/in/tok" async></script>',
    );
  });

  it("⭐ os parâmetros da Meta, com as macros preenchidas, viram campanha/conjunto/anúncio certos", () => {
    const preenchido = PARAMETROS_URL_META.replace("{{campaign.name}}", "Laser")
      .replace("{{adset.name}}", "Mulheres")
      .replace("{{ad.name}}", "Video")
      .replace("{{campaign.id}}", "120211")
      .replace("{{adset.id}}", "120222")
      .replace("{{ad.id}}", "120233");
    const p = pontoDeContatoDaVisita(Object.fromEntries(new URLSearchParams(preenchido)))!;
    expect([p.canal, p.campaignId, p.adsetId, p.adId]).toEqual(["meta_ads", "120211", "120222", "120233"]);
    expect([p.campaignName, p.adsetName, p.adName]).toEqual(["Laser", "Mulheres", "Video"]);
  });

  it("⭐ os parâmetros do Google, com o ValueTrack preenchido, viram campanha/grupo/anúncio/palavra-chave", () => {
    const preenchido = PARAMETROS_URL_GOOGLE.replace(/\{campaignid\}/g, "987654321")
      .replace("{adgroupid}", "112233445")
      .replace("{creative}", "667788990")
      .replace("{keyword}", "depilacao laser");
    const p = pontoDeContatoDaVisita({ ...Object.fromEntries(new URLSearchParams(preenchido)), gclid: "G" })!;
    expect([p.canal, p.campaignId, p.adsetId, p.adId, p.keyword]).toEqual([
      "google_ads",
      "987654321",
      "112233445",
      "667788990",
      "depilacao laser",
    ]);
  });
});
