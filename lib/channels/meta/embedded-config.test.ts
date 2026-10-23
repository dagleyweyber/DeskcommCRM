import { describe, expect, it } from "vitest";

import { embeddedSignupConfig } from "./embedded-config";

const completo = {
  META_APP_ID: "1234567890",
  META_APP_SECRET: "segredo-do-app",
  META_EMBEDDED_CONFIG_ID: "9876543210",
};

describe("embeddedSignupConfig", () => {
  it("com as três variáveis, devolve só o que o navegador precisa", () => {
    expect(embeddedSignupConfig(completo)).toEqual({ appId: "1234567890", configId: "9876543210" });
  });

  it("⭐ o App Secret nunca sai no retorno — o objeto vai pro navegador", () => {
    const cfg = embeddedSignupConfig(completo);
    expect(JSON.stringify(cfg)).not.toContain("segredo-do-app");
  });

  it("⭐ instalação sem nada configurado (o caso normal) devolve null, não erro", () => {
    expect(embeddedSignupConfig({})).toBeNull();
  });

  it.each(["META_APP_ID", "META_APP_SECRET", "META_EMBEDDED_CONFIG_ID"] as const)(
    "faltando %s o modo não liga — botão que abre fluxo que nunca conclui é pior que botão ausente",
    (faltando) => {
      expect(embeddedSignupConfig({ ...completo, [faltando]: "" })).toBeNull();
      expect(embeddedSignupConfig({ ...completo, [faltando]: undefined })).toBeNull();
    },
  );

  it("valor só com espaços conta como ausente (variável colada com lixo no .env)", () => {
    expect(embeddedSignupConfig({ ...completo, META_EMBEDDED_CONFIG_ID: "   " })).toBeNull();
  });
});
