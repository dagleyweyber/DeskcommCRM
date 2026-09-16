import { describe, expect, it } from "vitest";

import { resolveHeaderMediaStorage } from "./header-media-storage";

describe("resolveHeaderMediaStorage", () => {
  it("⭐ extrai o path de dentro de uma signed URL do bucket whatsapp-media", () => {
    const r = resolveHeaderMediaStorage({
      kind: "image",
      url: "https://ngihuluekwglwzejogvb.supabase.co/storage/v1/object/sign/whatsapp-media/147e0758-2646-48bc-a584-11fef86ab4fd/templates/9b325669.jpg?token=abc.def.ghi",
    });
    expect(r).toEqual({
      storagePath: "147e0758-2646-48bc-a584-11fef86ab4fd/templates/9b325669.jpg",
      mime: "image/jpeg",
    });
  });

  it("infere mime por extensão — png não vira jpeg por engano", () => {
    const r = resolveHeaderMediaStorage({
      kind: "image",
      url: "https://x.supabase.co/storage/v1/object/sign/whatsapp-media/a/b.png?token=t",
    });
    expect(r?.mime).toBe("image/png");
  });

  it("sem extensão reconhecida, cai no mime genérico do tipo do slot", () => {
    const r = resolveHeaderMediaStorage({
      kind: "document",
      url: "https://x.supabase.co/storage/v1/object/sign/whatsapp-media/a/arquivo?token=t",
    });
    expect(r?.mime).toBe("application/pdf");
  });

  it("URL fora do bucket whatsapp-media (link externo colado) devolve null — nada pra gravar", () => {
    const r = resolveHeaderMediaStorage({ kind: "video", url: "https://exemplo.com/video.mp4" });
    expect(r).toBeNull();
  });

  it("URL de outro bucket do mesmo projeto Supabase também devolve null", () => {
    const r = resolveHeaderMediaStorage({
      kind: "image",
      url: "https://x.supabase.co/storage/v1/object/sign/outro-bucket/a/b.jpg?token=t",
    });
    expect(r).toBeNull();
  });
});
