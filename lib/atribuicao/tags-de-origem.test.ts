import { describe, expect, it } from "vitest";

import { CANAL } from "./ponto-de-contato";
import { origensDoPonto, tagsDeOrigem, textosDasTags, type PontoParaTags } from "./tags-de-origem";

const ponto = (p: Partial<PontoParaTags> = {}): PontoParaTags => ({
  canal: CANAL.META_ADS,
  utmSource: null,
  landingUrl: null,
  referrer: null,
  campaignName: null,
  adName: null,
  ...p,
});

describe("origensDoPonto", () => {
  it("⭐ anúncio de WhatsApp cujo link é do Instagram: Meta Ads E Instagram", () => {
    // 526 dos 620 pontos de contato de produção têm exatamente este host.
    expect(origensDoPonto(ponto({ landingUrl: "https://www.instagram.com/p/DXYZ/" }))).toEqual(["meta-ads", "instagram"]);
  });

  it("anúncio com link fb.me ou wa.me é só Meta Ads — sem palpite de Instagram", () => {
    expect(origensDoPonto(ponto({ landingUrl: "https://fb.me/abc" }))).toEqual(["meta-ads"]);
    expect(origensDoPonto(ponto({ landingUrl: "https://wa.me/5511999999999" }))).toEqual(["meta-ads"]);
  });

  it("landing page: utm_source ig/instagram ou referenciador l.instagram.com", () => {
    expect(origensDoPonto(ponto({ utmSource: "IG" }))).toEqual(["meta-ads", "instagram"]);
    expect(origensDoPonto(ponto({ utmSource: "facebook", referrer: "https://l.instagram.com/?u=x" }))).toEqual([
      "meta-ads",
      "instagram",
    ]);
    expect(origensDoPonto(ponto({ utmSource: "facebook" }))).toEqual(["meta-ads"]);
  });

  it("não confunde domínio parecido com Instagram", () => {
    expect(origensDoPonto(ponto({ landingUrl: "https://notinstagram.com/x" }))).toEqual(["meta-ads"]);
  });

  it("Google e TikTok", () => {
    expect(origensDoPonto(ponto({ canal: CANAL.GOOGLE_ADS }))).toEqual(["google-ads"]);
    expect(origensDoPonto(ponto({ canal: CANAL.TIKTOK_ADS }))).toEqual(["tiktok-ads"]);
  });

  it("⭐ canal 'outro' (newsletter, teste…) NÃO vira Origem", () => {
    expect(origensDoPonto(ponto({ canal: CANAL.OUTRO, utmSource: "newsletter" }))).toEqual([]);
  });

  it("URL inválida não derruba", () => {
    expect(origensDoPonto(ponto({ landingUrl: "isto não é url" }))).toEqual(["meta-ads"]);
  });
});

describe("tagsDeOrigem", () => {
  it("⭐ só entra campanha/anúncio COM NOME — id numérico não vira tag", () => {
    const t = tagsDeOrigem(ponto({ landingUrl: "https://fb.me/x" }));
    expect(textosDasTags(t)).toEqual(["origem:meta-ads"]);
  });

  it("usa o nome que a Meta devolveu depois, quando o ponto não tinha", () => {
    const t = tagsDeOrigem(ponto({ landingUrl: "https://fb.me/x" }), { campaignName: "Botox Out/26", adName: "Vídeo 1" });
    expect(textosDasTags(t)).toEqual(["origem:meta-ads", "campanha:Botox Out/26", "anuncio:Vídeo 1"]);
  });

  it("o nome do próprio ponto (UTM da landing page) vale mais que o da consulta", () => {
    const t = tagsDeOrigem(ponto({ campaignName: "da-utm" }), { campaignName: "da-meta" });
    expect(textosDasTags(t)).toContain("campanha:da-utm");
  });

  it("⭐ o nome da campanha vai EXATO, com a vírgula do preço", () => {
    const t = tagsDeOrigem(ponto({ campaignName: "LASER 29,90 IMAGEM" }));
    expect(textosDasTags(t)).toContain("campanha:LASER 29,90 IMAGEM");
  });

  it("canal outro: nenhuma tag", () => {
    expect(tagsDeOrigem(ponto({ canal: CANAL.OUTRO, campaignName: "x" }))).toEqual([]);
  });
});
