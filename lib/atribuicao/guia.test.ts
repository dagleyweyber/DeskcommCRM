import { describe, expect, it } from "vitest";

import { scriptDeRastreio, scriptSoCampos, urlDeCliqueDoWebhook } from "./guia";

const CRM = "https://crm.exemplo";
const WEBHOOK = "https://crm.exemplo/api/v1/webhooks/in/tok_teste123";

describe("guia de rastreamento", () => {
  it("⭐ o endereço de clique é o MESMO token do webhook, em /rastreio/clique/", () => {
    expect(urlDeCliqueDoWebhook(WEBHOOK)).toBe("https://crm.exemplo/api/v1/rastreio/clique/tok_teste123");
  });

  it("script de envio direto: sem data-clique (o script deriva do data-webhook)", () => {
    expect(scriptDeRastreio(CRM, WEBHOOK)).toBe(`<script src="${CRM}/rastreio.js" data-webhook="${WEBHOOK}" async></script>`);
  });

  it("⭐ script 'só campos' sem webhook continua igual (compatível com quem já colou)", () => {
    expect(scriptSoCampos(CRM)).toBe(`<script src="${CRM}/rastreio.js" async></script>`);
  });

  it("⭐ script 'só campos' com webhook leva data-clique — esse modo não tem data-webhook de onde derivar", () => {
    expect(scriptSoCampos(CRM, WEBHOOK)).toBe(
      `<script src="${CRM}/rastreio.js" data-clique="https://crm.exemplo/api/v1/rastreio/clique/tok_teste123" async></script>`,
    );
  });
});
