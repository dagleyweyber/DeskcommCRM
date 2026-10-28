import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALFABETO_DO_CODIGO,
  TAMANHO_DO_CODIGO,
  extraiCodigoDaMensagem,
  normalizaCodigo,
  parametrosDoClique,
  temSinalDeAnuncio,
} from "./clique-whatsapp";

describe("normalizaCodigo", () => {
  it("aceita minúscula e espaço nas pontas; devolve maiúscula", () => {
    expect(normalizaCodigo(" k7m2qx ")).toBe("K7M2QX");
  });

  it("⭐ recusa o que o alfabeto não tem (0, O, 1, I), tamanho errado e não-texto", () => {
    expect(normalizaCodigo("K7M2Q0")).toBeNull();
    expect(normalizaCodigo("K7M2QO")).toBeNull();
    expect(normalizaCodigo("K7M2Q1")).toBeNull();
    expect(normalizaCodigo("K7M2QI")).toBeNull();
    expect(normalizaCodigo("K7M2Q")).toBeNull();
    expect(normalizaCodigo("K7M2QXA")).toBeNull();
    expect(normalizaCodigo(123456)).toBeNull();
    expect(normalizaCodigo(null)).toBeNull();
  });
});

describe("extraiCodigoDaMensagem", () => {
  it("acha o código no fim do texto pré-preenchido", () => {
    expect(extraiCodigoDaMensagem("Quero agendar ref:K7M2QX")).toBe("K7M2QX");
  });

  it("⭐ o cliente pode ter mexido na pontuação ou na caixa", () => {
    expect(extraiCodigoDaMensagem("Oi (ref K7M2QX)")).toBe("K7M2QX");
    expect(extraiCodigoDaMensagem("Oi REF-k7m2qx")).toBe("K7M2QX");
    expect(extraiCodigoDaMensagem("ref:K7M2QX quero saber o preço")).toBe("K7M2QX");
  });

  it("⭐ palavra comum que começa com 'ref' não vira código", () => {
    expect(extraiCodigoDaMensagem("Preciso de uma referência")).toBeNull();
    expect(extraiCodigoDaMensagem("refabcdef")).toBeNull();
  });

  it("código com 7 símbolos ou com caractere fora do alfabeto não casa", () => {
    expect(extraiCodigoDaMensagem("ref:K7M2QXA")).toBeNull();
    expect(extraiCodigoDaMensagem("ref:K7M2Q0")).toBeNull();
  });

  it("sem texto ou sem código: null", () => {
    expect(extraiCodigoDaMensagem(null)).toBeNull();
    expect(extraiCodigoDaMensagem("")).toBeNull();
    expect(extraiCodigoDaMensagem("Olá, boa tarde")).toBeNull();
  });
});

describe("parametrosDoClique", () => {
  it("⭐ só guarda o que está na allowlist — rota aberta não vira depósito de JSON", () => {
    const p = parametrosDoClique({
      codigo: "K7M2QX",
      gclid: "Cj0K_ABC",
      utm_source: "google",
      senha: "123",
      html: "<script>",
      "__proto__": "x",
    });
    expect(p).toEqual({ gclid: "Cj0K_ABC", utm_source: "google" });
  });

  it("descarta parâmetro dinâmico não substituído ({campaignid}) e valor vazio", () => {
    expect(parametrosDoClique({ campaign_id: "{campaignid}", gclid: "  ", utm_source: "google" })).toEqual({ utm_source: "google" });
  });

  it("chaves em maiúscula valem; o primeiro toque (JSON em texto) é guardado, com teto", () => {
    expect(parametrosDoClique({ GCLID: "A1", dc_primeiro_contato: '{"gclid":"B2"}' })).toEqual({
      gclid: "A1",
      dc_primeiro_contato: '{"gclid":"B2"}',
    });
    expect(parametrosDoClique({ gclid: "A1", dc_primeiro_contato: "x".repeat(3001) })).toEqual({ gclid: "A1" });
  });
});

describe("temSinalDeAnuncio", () => {
  it("só página/referenciador/navegador não é sinal de anúncio", () => {
    expect(temSinalDeAnuncio({ landing_url: "https://lp.exemplo/", client_user_agent: "x", referrer: "https://google.com" })).toBe(false);
  });
  it("gclid, UTM ou id de campanha é", () => {
    expect(temSinalDeAnuncio({ gclid: "A" })).toBe(true);
    expect(temSinalDeAnuncio({ utm_source: "google" })).toBe(true);
    expect(temSinalDeAnuncio({ campaign_id: "1" })).toBe(true);
  });
});

describe("o formato do código é o MESMO no script, no servidor e no banco", () => {
  it("⭐ alfabeto do rastreio.js = alfabeto do servidor", () => {
    const js = readFileSync(join(process.cwd(), "public", "rastreio.js"), "utf8");
    const m = /var ALFABETO = "([A-Z0-9]+)";/.exec(js);
    expect(m?.[1]).toBe(ALFABETO_DO_CODIGO);
  });

  it("o alfabeto tem 32 símbolos (módulo 256 uniforme) e não tem 0/O/1/I", () => {
    expect(ALFABETO_DO_CODIGO).toHaveLength(32);
    expect(ALFABETO_DO_CODIGO).not.toMatch(/[01OI]/);
    expect(TAMANHO_DO_CODIGO).toBe(6);
  });

  it("⭐ o CHECK da tabela aceita exatamente o que o servidor aceita", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261028150000_0203_rastreio_cliques.sql"), "utf8");
    expect(sql).toContain("check (codigo ~ '^[A-HJ-NP-Z2-9]{6}$')");
    for (const c of ALFABETO_DO_CODIGO) expect(new RegExp("^[A-HJ-NP-Z2-9]{1}$").test(c)).toBe(true);
  });
});
