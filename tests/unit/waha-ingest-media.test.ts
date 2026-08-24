import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// os helpers testados aqui são puros — mock corta a cadeia.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import {
  adReferralDe,
  mediaMimeOf,
  mediaUrlOf,
  resolveMessageType,
  type WahaPayload,
} from "@/lib/waha/ingest";

// Formato real do WAHA 2026.7.1 / NOWEB capturado em webhook_events_log:
// mídia em payload.media.{url,mimetype}; sem `type`; conteúdo em _data.message.
function nowebPayload(messageKey: string, mimetype: string): WahaPayload {
  return {
    id: "false_x@lid_ABC",
    from: "59782320914646@lid",
    fromMe: false,
    hasMedia: true,
    media: {
      url: "http://localhost:3000/api/files/sessao/ABC.bin",
      mimetype,
      filename: null,
    },
    _data: { message: { [messageKey]: {}, messageContextInfo: {} } },
  };
}

describe("mediaUrlOf / mediaMimeOf", () => {
  it("lê o formato novo (payload.media.*)", () => {
    const p = nowebPayload("imageMessage", "image/jpeg");
    expect(mediaUrlOf(p)).toBe("http://localhost:3000/api/files/sessao/ABC.bin");
    expect(mediaMimeOf(p)).toBe("image/jpeg");
  });

  it("mantém o formato legado (payload.mediaUrl) com precedência", () => {
    const p: WahaPayload = { mediaUrl: "http://w/legacy.jpg", mimetype: "image/png" };
    expect(mediaUrlOf(p)).toBe("http://w/legacy.jpg");
    expect(mediaMimeOf(p)).toBe("image/png");
  });

  it("retorna null sem mídia", () => {
    expect(mediaUrlOf({ body: "oi" })).toBeNull();
    expect(mediaMimeOf({ body: "oi" })).toBeNull();
  });
});

describe("resolveMessageType", () => {
  it("usa `type` explícito quando presente (legado)", () => {
    expect(resolveMessageType({ type: "ptt" })).toBe("audio");
    expect(resolveMessageType({ type: "chat" })).toBe("text");
  });

  it("infere pela chave de _data.message (NOWEB sem type)", () => {
    expect(resolveMessageType(nowebPayload("stickerMessage", "image/webp"))).toBe("sticker");
    expect(resolveMessageType(nowebPayload("imageMessage", "image/jpeg"))).toBe("image");
    expect(resolveMessageType(nowebPayload("audioMessage", "audio/ogg; codecs=opus"))).toBe("audio");
    expect(resolveMessageType(nowebPayload("videoMessage", "video/mp4"))).toBe("video");
    expect(resolveMessageType(nowebPayload("documentMessage", "application/pdf"))).toBe("document");
    expect(resolveMessageType(nowebPayload("documentWithCaptionMessage", "application/pdf"))).toBe(
      "document",
    );
  });

  it("cai no prefixo do MIME quando a chave é desconhecida", () => {
    const p = nowebPayload("futureMessageKind", "video/mp4");
    expect(resolveMessageType(p)).toBe("video");
  });

  it("webp sem chave conhecida vira sticker", () => {
    const p = nowebPayload("futureMessageKind", "image/webp");
    expect(resolveMessageType(p)).toBe("sticker");
  });

  it("sem type, sem message e sem mídia → text", () => {
    expect(resolveMessageType({ body: "oi" })).toBe("text");
  });
});

describe("adReferralDe — o clique em anúncio (Fase A da atribuição pro Meta Ads)", () => {
  function withExternalAdReply(
    messageKey: string,
    info: Record<string, unknown>,
  ): WahaPayload {
    return {
      id: "false_x@lid_ABC",
      from: "5531999999999@s.whatsapp.net",
      fromMe: false,
      body: "oi",
      _data: {
        message: {
          [messageKey]: { contextInfo: { externalAdReplyInfo: info } },
        },
      },
    };
  }

  it("⭐ extrai ctwaClid + sourceId + title + sourceUrl de extendedTextMessage (resposta de texto a um CTWA)", () => {
    const p = withExternalAdReply("extendedTextMessage", {
      ctwaClid: "AbCdEf123",
      sourceId: "120210000000000",
      title: "Promoção de Botox",
      sourceUrl: "https://fb.me/xyz",
    });
    expect(adReferralDe(p)).toEqual({
      clickId: "AbCdEf123",
      sourceId: "120210000000000",
      headline: "Promoção de Botox",
      sourceUrl: "https://fb.me/xyz",
    });
  });

  it("também acha o contextInfo dentro de uma mensagem de mídia (imageMessage)", () => {
    const p = withExternalAdReply("imageMessage", { ctwaClid: "XYZ", sourceId: "1" });
    expect(adReferralDe(p)?.clickId).toBe("XYZ");
  });

  it("mensagem comum, sem contextInfo, devolve null (maioria das mensagens)", () => {
    const p: WahaPayload = { id: "x", from: "553199@s.whatsapp.net", body: "oi", _data: { message: { conversation: "oi" } } };
    expect(adReferralDe(p)).toBeNull();
  });

  it("sem _data.message nenhum, devolve null", () => {
    expect(adReferralDe({ id: "x", body: "oi" })).toBeNull();
  });

  it("externalAdReplyInfo sem ctwaClid nem sourceId vira null — objeto vazio não é atribuição", () => {
    const p = withExternalAdReply("extendedTextMessage", { title: "algo" });
    expect(adReferralDe(p)).toBeNull();
  });
});
