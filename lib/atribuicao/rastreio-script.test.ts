import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O script público `public/rastreio.js` — o que vai colado nas landing pages dos
 * clientes. Medido em produção antes dele: 0 de 19 leads de landing page tinham
 * qualquer dado de origem.
 */
const CODIGO = readFileSync(join(process.cwd(), "public", "rastreio.js"), "utf8");

declare global {
  interface Window {
    DeskcommRastreio?: {
      dados: () => Record<string, string>;
      preencher: (f: HTMLFormElement) => void;
      enviar: (f: HTMLFormElement) => void;
    };
  }
}

function visitar(caminho: string, opts: { webhook?: string } = {}) {
  window.history.replaceState({}, "", caminho);
  delete window.DeskcommRastreio;
  const script = document.createElement("script");
  if (opts.webhook) script.setAttribute("data-webhook", opts.webhook);
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  new Function(CODIGO)();
}

function novoFormulario(html: string): HTMLFormElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const form = wrap.querySelector("form") as HTMLFormElement;
  document.body.appendChild(wrap);
  return form;
}

function enviar(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const campo = (form: HTMLFormElement, nome: string) =>
  (form.elements.namedItem(nome) as HTMLInputElement | null)?.value ?? null;

beforeEach(() => {
  localStorage.clear();
  for (const c of document.cookie.split(";")) {
    const nome = c.split("=")[0]?.trim();
    if (nome) document.cookie = `${nome}=; max-age=0; path=/`;
  }
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public/rastreio.js — campos ocultos no formulário", () => {
  it("⭐ visita de anúncio da Meta: campanha, conjunto e anúncio chegam no formulário", () => {
    visitar(
      "/lp?utm_source=facebook&utm_campaign=Black%20Friday&campaign_id=120211&adset_id=120222&ad_id=120233&fbclid=IwAR_ABC",
    );
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    enviar(form);

    expect(campo(form, "utm_source")).toBe("facebook");
    expect(campo(form, "utm_campaign")).toBe("Black Friday");
    expect(campo(form, "campaign_id")).toBe("120211");
    expect(campo(form, "adset_id")).toBe("120222");
    expect(campo(form, "ad_id")).toBe("120233");
    expect(campo(form, "fbclid")).toBe("IwAR_ABC");
    // fbc no formato da Meta: fb.1.<milissegundos do clique>.<fbclid>
    expect(campo(form, "fbc")).toMatch(/^fb\.1\.\d{13}\.IwAR_ABC$/);
    expect(campo(form, "client_user_agent")).toBeTruthy();
    expect(campo(form, "landing_url")).toContain("/lp?");
  });

  it("⭐ parâmetro dinâmico NÃO substituído ({{ad.id}}) não vira id de anúncio", () => {
    visitar("/lp?utm_source=facebook&ad_id={{ad.id}}&campaign_id=%7Bcampaignid%7D");
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    enviar(form);
    expect(campo(form, "ad_id")).toBeNull();
    expect(campo(form, "campaign_id")).toBeNull();
    expect(campo(form, "utm_source")).toBe("facebook");
  });

  it("⭐ a origem sobrevive à navegação: chega na LP pelo anúncio, envia o formulário em outra página", () => {
    visitar("/?utm_source=google&gclid=Cj0K_XYZ&campaign_id=987654321");
    visitar("/contato"); // sem parâmetros
    const form = novoFormulario(`<form><input name="email" value="a@b.com"></form>`);
    enviar(form);
    expect(campo(form, "gclid")).toBe("Cj0K_XYZ");
    expect(campo(form, "campaign_id")).toBe("987654321");
  });

  it("⭐ primeiro e último toque: o primeiro vai em dc_primeiro_contato", () => {
    visitar("/?utm_source=facebook&campaign_id=111111");
    visitar("/?utm_source=google&gclid=G1&campaign_id=222222");
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    enviar(form);

    expect(campo(form, "campaign_id")).toBe("222222");
    const primeiro = JSON.parse(campo(form, "dc_primeiro_contato") ?? "{}");
    expect(primeiro.campaign_id).toBe("111111");
    expect(primeiro.utm_source).toBe("facebook");
  });

  it("não sobrescreve campo que a própria página já tem com o mesmo nome", () => {
    visitar("/?utm_source=facebook");
    const form = novoFormulario(`<form><input type="hidden" name="utm_source" value="manual"></form>`);
    enviar(form);
    expect(campo(form, "utm_source")).toBe("manual");
  });

  it("formulário marcado com data-dc-rastreio=off fica intocado", () => {
    visitar("/?utm_source=facebook");
    const form = novoFormulario(`<form data-dc-rastreio="off"><input name="q"></form>`);
    enviar(form);
    expect(campo(form, "utm_source")).toBeNull();
  });

  it("formulário que aparece depois (popup) também recebe os campos", async () => {
    visitar("/?utm_source=facebook&ad_id=555555");
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    await new Promise((r) => setTimeout(r, 0));
    expect(campo(form, "ad_id")).toBe("555555");
  });
});

describe("public/rastreio.js — envio direto ao CRM (data-webhook)", () => {
  const WEBHOOK = "https://crm.exemplo/api/v1/webhooks/in/tok_teste123";

  function capturaBeacon() {
    const chamadas: Array<{ url: string; corpo: Promise<string> }> = [];
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (url: string, dados: Blob) => {
        chamadas.push({ url, corpo: dados.text() });
        return true;
      },
    });
    return chamadas;
  }

  it("⭐ envia o lead com a origem, mesmo com nomes de campo de construtor (form_fields[...])", async () => {
    const chamadas = capturaBeacon();
    visitar("/?utm_source=facebook&campaign_id=120211&ad_id=120233", { webhook: WEBHOOK });
    const form = novoFormulario(`
      <form>
        <input name="form_fields[name]" value="Ana Souza">
        <input name="form_fields[email]" value="ana@exemplo.com">
        <input name="form_fields[telefone]" value="(81) 99999-0000">
        <input type="password" name="senha" value="segredo">
      </form>`);
    enviar(form);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(WEBHOOK);
    const corpo = new URLSearchParams(await chamadas[0]!.corpo);
    expect(corpo.get("name")).toBe("Ana Souza");
    expect(corpo.get("email")).toBe("ana@exemplo.com");
    expect(corpo.get("telefone")).toBe("(81) 99999-0000");
    expect(corpo.get("campaign_id")).toBe("120211");
    expect(corpo.get("ad_id")).toBe("120233");
    expect(corpo.get("external_id")).toBeTruthy();
    expect(corpo.has("senha")).toBe(false);
  });

  it("clique duplo não manda duas vezes", () => {
    const chamadas = capturaBeacon();
    visitar("/?utm_source=facebook", { webhook: WEBHOOK });
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    enviar(form);
    enviar(form);
    expect(chamadas).toHaveLength(1);
  });

  it("sem data-webhook, nada sai da página — só os campos ocultos", () => {
    const chamadas = capturaBeacon();
    visitar("/?utm_source=facebook");
    const form = novoFormulario(`<form><input name="nome" value="Ana"></form>`);
    enviar(form);
    expect(chamadas).toHaveLength(0);
  });
});
