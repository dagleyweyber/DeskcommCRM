import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseMetaWebhook, type InboundMessageEvent } from "@/lib/channels/meta/webhook";

/**
 * Payloads REAIS capturados da WABA de teste em 2026-07-29 — um texto e uma nota de
 * voz, enviados de um celular de verdade. Mock escrito por quem escreve o parser
 * concorda com ele por construção; foi assim que a Fase 3a descobriu que
 * `parameter_format` só vem se pedido e que `quality_score` vem como objeto.
 */
const REAIS = JSON.parse(
  readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8"),
) as Parameters<typeof parseMetaWebhook>[0][];

const inbound = (i: number) =>
  parseMetaWebhook(REAIS[i]!).filter(
    (e): e is InboundMessageEvent => e.kind === "inbound_message",
  );

describe("inbound real — texto", () => {
  it("extrai a mensagem, o remetente e o número NOSSO que recebeu", () => {
    const [e] = inbound(0);
    expect(e).toMatchObject({
      kind: "inbound_message",
      from: "553198966398",
      phoneNumberId: "1103328999528818",
      type: "text",
      text: "oi",
      profileName: "Contato Teste",
    });
  });

  it("o `wamid` vira a chave de idempotência", () => {
    const [e] = inbound(0);
    expect(e!.externalId).toMatch(/^wamid\./);
  });

  it("o timestamp vem em SEGUNDOS — tratá-lo como ms daria 1970", () => {
    const [e] = inbound(0);
    expect(e!.sentAt.getUTCFullYear()).toBe(2026);
  });

  it("texto não tem mídia", () => {
    expect(inbound(0)[0]!.media).toBeNull();
  });
});

describe("inbound real — nota de voz", () => {
  it("reconhece áudio e marca `voice`", () => {
    const [e] = inbound(1);
    expect(e!.type).toBe("audio");
    expect(e!.media).toMatchObject({ voice: true, mime: "audio/ogg; codecs=opus" });
  });

  it("a Meta manda URL PRONTA, não só o media_id", () => {
    // Eu tinha antecipado que viria só o id, exigindo outra chamada à Graph API.
    // Vem os dois — e a URL tem `ext=` de expiração, então baixe na hora.
    const [e] = inbound(1);
    expect(e!.media!.id).toBeTruthy();
    expect(e!.media!.url).toContain("lookaside.fbsbx.com");
  });

  it("nota de voz não tem `text`", () => {
    expect(inbound(1)[0]!.text).toBeNull();
  });
});

describe("o que separa inbound de status de entrega", () => {
  it("`messages[]` é do CONTATO; `statuses[]` é das NOSSAS", () => {
    // Os dois chegam no mesmo `field: "messages"`. Tratá-los no mesmo `if` faria um
    // mascarar o outro quando viessem juntos no mesmo payload.
    const misto = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                contacts: [{ wa_id: "5531", profile: { name: "Ana" } }],
                messages: [{ id: "wamid.IN", from: "5531", timestamp: "1785342028", type: "text", text: { body: "oi" } }],
              },
            },
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: "5531" }] },
            },
          ],
        },
      ],
    });
    expect(misto.map((e) => e.kind)).toEqual(["inbound_message", "message_status"]);
  });
});

describe("adReferral — o clique em anúncio (Fase A da atribuição pro Meta Ads)", () => {
  const envelopeComReferral = (referral: Record<string, unknown>) => ({
    object: "whatsapp_business_account" as const,
    entry: [
      {
        id: "w",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn1" },
              messages: [
                { id: "wamid.AD", from: "5531", timestamp: "1785342028", type: "text", text: { body: "oi" }, referral },
              ],
            },
          },
        ],
      },
    ],
  });

  it("⭐ extrai ctwa_clid + source_id + headline + source_url do referral", () => {
    const [e] = parseMetaWebhook(
      envelopeComReferral({
        source_id: "120210000000000",
        source_type: "ad",
        source_url: "https://fb.me/xyz",
        headline: "Promoção de Botox",
        ctwa_clid: "AbCdEf123",
      }),
    ) as InboundMessageEvent[];
    expect(e!.adReferral).toEqual({
      clickId: "AbCdEf123",
      sourceId: "120210000000000",
      sourceType: "ad",
      headline: "Promoção de Botox",
      sourceUrl: "https://fb.me/xyz",
    });
  });

  it("sem referral no payload, adReferral é null (maioria das mensagens)", () => {
    const [e] = inbound(0);
    expect(e!.adReferral).toBeNull();
  });

  it("referral sem ctwa_clid nem source_id vira null — objeto vazio não é atribuição", () => {
    const [e] = parseMetaWebhook(
      envelopeComReferral({ source_type: "post" }),
    ) as InboundMessageEvent[];
    expect(e!.adReferral).toBeNull();
  });

  it("source_id sem ctwa_clid ainda é atribuição válida (clickId null, resto preenchido)", () => {
    const [e] = parseMetaWebhook(
      envelopeComReferral({ source_id: "12345", source_type: "post" }),
    ) as InboundMessageEvent[];
    expect(e!.adReferral).toMatchObject({ clickId: null, sourceId: "12345" });
  });
});

describe("payload capenga não vira linha meia-boca", () => {
  it("mensagem sem id é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ from: "5531", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("mensagem sem remetente é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ id: "wamid.X", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("tipo que não conhecemos ainda atravessa, sem mídia inventada", () => {
    // Sticker/location/contact chegam com formas próprias. Descartar seria perder
    // mensagem do cliente; inventar mídia seria pior.
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                messages: [{ id: "wamid.S", from: "5531", timestamp: "1785342028", type: "location" }],
              },
            },
          ],
        },
      ],
    }) as InboundMessageEvent[];
    expect(e).toMatchObject({ type: "location", text: null, media: null });
  });
});
