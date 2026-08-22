import { describe, expect, it } from "vitest";

import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { wahaSendPlanFor } from "@/lib/waha/media-send";

const media = { url: "https://signed.example/x?token=t", mime: "image/jpeg", filename: "x.jpg", caption: "oi" };

describe("wahaSendPlanFor", () => {
  it("image → sendImage com caption", () => {
    const plan = wahaSendPlanFor("image", media);
    expect(plan.endpoint).toBe("sendImage");
    expect(plan.payload.caption).toBe("oi");
    expect((plan.payload.file as { url: string }).url).toBe(media.url);
  });
  it("video → sendVideo com caption e convert", () => {
    const plan = wahaSendPlanFor("video", { ...media, mime: "video/mp4" });
    expect(plan.endpoint).toBe("sendVideo");
    expect(plan.payload.convert).toBe(true);
  });
  it("audio → sendVoice com convert (WhatsApp exige OGG/OPUS)", () => {
    const plan = wahaSendPlanFor("audio", { ...media, mime: "audio/webm;codecs=opus" });
    expect(plan.endpoint).toBe("sendVoice");
    expect(plan.payload.convert).toBe(true);
    expect(plan.payload.caption).toBeUndefined(); // voz não tem caption no WhatsApp
  });
  it("document (e desconhecidos) → sendFile com filename", () => {
    const plan = wahaSendPlanFor("document", { ...media, mime: "application/pdf", filename: "doc.pdf" });
    expect(plan.endpoint).toBe("sendFile");
    expect((plan.payload.file as { filename: string }).filename).toBe("doc.pdf");
  });
});

describe("isMediaPathOwnedBy", () => {
  const orgId = "org-1";
  const conversationId = "conv-1";

  it("path da própria org/conversa → true", () => {
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(true);
  });
  it("org diferente → false", () => {
    expect(isMediaPathOwnedBy(`org-2/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("conversa diferente → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}/conv-2/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("confusão de prefixo (org-1x/...) → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}x/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });

  // ⭐ Mídia de follow-up (app/api/v1/ai/followups/media/route.ts) nasce ANTES
  // de existir conversa — sem este segundo prefixo, send_media falhava 100%
  // das vezes com "media_storage_path fora da conversa", medido em produção
  // pra qualquer lead, sempre no primeiro nó de mídia do fluxo.
  it("⭐ path {org}/followup-media/... (reutilizável entre conversas) → true, mesmo sem casar a conversa", () => {
    expect(isMediaPathOwnedBy(`${orgId}/followup-media/x.jpg`, orgId, conversationId)).toBe(true);
    expect(isMediaPathOwnedBy(`${orgId}/followup-media/x.jpg`, orgId, "qualquer-outra-conversa")).toBe(true);
  });
  it("followup-media de OUTRA org → false (a fronteira continua sendo a organização)", () => {
    expect(isMediaPathOwnedBy(`org-2/followup-media/x.jpg`, orgId, conversationId)).toBe(false);
  });
});
