import { describe, expect, it } from "vitest";

import { extractHeaderMedia, type MetaSendComponent } from "./build-components";

describe("extractHeaderMedia", () => {
  it("⭐ acha a imagem dentro do componente de cabeçalho", () => {
    const components: MetaSendComponent[] = [
      { type: "header", parameters: [{ type: "image", image: { link: "https://x/img.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Oi" }] },
    ];
    expect(extractHeaderMedia(components)).toEqual({ kind: "image", url: "https://x/img.jpg" });
  });

  it("acha vídeo e documento também", () => {
    expect(
      extractHeaderMedia([
        { type: "header", parameters: [{ type: "video", video: { link: "https://x/v.mp4" } }] },
      ]),
    ).toEqual({ kind: "video", url: "https://x/v.mp4" });

    expect(
      extractHeaderMedia([
        { type: "header", parameters: [{ type: "document", document: { link: "https://x/d.pdf" } }] },
      ]),
    ).toEqual({ kind: "document", url: "https://x/d.pdf" });
  });

  it("cabeçalho de TEXTO (sem mídia) devolve null — não é o slot que este helper serve", () => {
    const components: MetaSendComponent[] = [
      { type: "header", parameters: [{ type: "text", text: "Olá Sara" }] },
      { type: "body", parameters: [{ type: "text", text: "Oi" }] },
    ];
    expect(extractHeaderMedia(components)).toBeNull();
  });

  it("template sem cabeçalho nenhum devolve null", () => {
    const components: MetaSendComponent[] = [{ type: "body", parameters: [{ type: "text", text: "Oi" }] }];
    expect(extractHeaderMedia(components)).toBeNull();
  });
});
