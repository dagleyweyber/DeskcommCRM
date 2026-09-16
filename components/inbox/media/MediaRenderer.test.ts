import { describe, expect, it } from "vitest";

import { tipoEfetivoDeMidia } from "./MediaRenderer";

/**
 * Achado ao vivo (RevitaFio Mossoró): mensagem `type: "template"` com
 * cabeçalho de imagem sempre caía no `default` (DocumentCard, ficha
 * genérica pra baixar) porque o dispatcher decidia só por `message.type` —
 * que pra QUALQUER template é sempre "template", nunca "image"/"video". O
 * `type` da mensagem continua "template" de propósito (custo/janela de
 * conformidade contam com isso); o desempate certo é pelo `media_mime`.
 */
describe("tipoEfetivoDeMidia", () => {
  it("⭐ template com media_mime image/* vira 'image'", () => {
    expect(tipoEfetivoDeMidia({ type: "template", media_mime: "image/jpeg" })).toBe("image");
  });

  it("template com media_mime video/* vira 'video'", () => {
    expect(tipoEfetivoDeMidia({ type: "template", media_mime: "video/mp4" })).toBe("video");
  });

  it("template com media_mime de documento cai no default (DocumentCard)", () => {
    expect(tipoEfetivoDeMidia({ type: "template", media_mime: "application/pdf" })).toBe("document");
  });

  it("template SEM media_mime (corpo/botão, sem cabeçalho de mídia) mantém 'template' — MediaRenderer nem é chamado nesse caso", () => {
    expect(tipoEfetivoDeMidia({ type: "template", media_mime: null })).toBe("template");
  });

  it("mensagem de imagem de verdade (não-template) não passa pelo desempate", () => {
    expect(tipoEfetivoDeMidia({ type: "image", media_mime: "image/jpeg" })).toBe("image");
  });
});
