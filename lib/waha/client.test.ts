import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIG_DE_SESSAO, WahaClient, WahaStoreDesligadoError } from "./client";

interface Chamada {
  url: string;
  method: string;
  body: unknown;
}

/** `fetch` falso: responde pela ordem e registra o que foi pedido. */
function fingirFetch(respostas: Array<{ status: number; corpo?: unknown }>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const r = respostas[i++] ?? { status: 200, corpo: {} };
      const texto = typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {});
      return new Response(texto, { status: r.status });
    }),
  );
  return chamadas;
}

const waha = new WahaClient("http://waha:3000", "chave");

afterEach(() => vi.unstubAllGlobals());

describe("CONFIG_DE_SESSAO", () => {
  it("liga o armazenamento e a sincronização completa", () => {
    expect(CONFIG_DE_SESSAO.noweb.store).toEqual({ enabled: true, fullSync: true });
  });
});

describe("startSession", () => {
  it("⭐ toda sessão NASCE com o armazenamento ligado — sem isso a agenda nunca é guardada", async () => {
    const chamadas = fingirFetch([{ status: 201 }, { status: 200, corpo: { status: "STARTING" } }]);
    await waha.startSession("org_x");
    const criar = chamadas.find((c) => c.method === "POST" && c.url.endsWith("/api/sessions"));
    expect(criar?.body).toEqual({ name: "org_x", config: CONFIG_DE_SESSAO });
  });

  it("sessão que já existe NÃO tem a configuração mexida numa reconexão comum", async () => {
    const chamadas = fingirFetch([{ status: 422 }, { status: 200, corpo: { status: "WORKING" } }]);
    await waha.startSession("org_x");
    expect(chamadas.some((c) => c.method === "PUT")).toBe(false);
  });

  it("⭐ com reaplicarConfig, sessão existente recebe a configuração ANTES de iniciar", async () => {
    const chamadas = fingirFetch([
      { status: 422 },
      { status: 200 },
      { status: 200, corpo: { status: "STARTING" } },
    ]);
    await waha.startSession("org_x", { reaplicarConfig: true });
    expect(chamadas.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
    expect(chamadas[1]).toMatchObject({
      url: "http://waha:3000/api/sessions/org_x",
      body: { name: "org_x", config: CONFIG_DE_SESSAO },
    });
    expect(chamadas[2]?.url.endsWith("/api/sessions/org_x/start")).toBe(true);
  });

  it("reaplicarConfig em sessão NOVA não faz PUT (a criação já levou a configuração)", async () => {
    const chamadas = fingirFetch([{ status: 201 }, { status: 200, corpo: { status: "STARTING" } }]);
    await waha.startSession("org_x", { reaplicarConfig: true });
    expect(chamadas.some((c) => c.method === "PUT")).toBe(false);
  });

  it("falha ao reaplicar a configuração sobe — não finge que a agenda vai ser guardada", async () => {
    fingirFetch([{ status: 422 }, { status: 500, corpo: "boom" }]);
    await expect(waha.startSession("org_x", { reaplicarConfig: true })).rejects.toThrow(
      /waha_update_500/,
    );
  });
});

describe("listContacts / listChatsOverview", () => {
  it("⭐ 400 citando o armazenamento vira WahaStoreDesligadoError, não erro genérico", async () => {
    fingirFetch([
      {
        status: 400,
        corpo: { message: 'Enable NOWEB store "config.noweb.store.enabled=True" when starting a new session.' },
      },
    ]);
    await expect(waha.listContacts("s", { limit: 5, offset: 0 })).rejects.toBeInstanceOf(
      WahaStoreDesligadoError,
    );
  });

  it("o mesmo vale para as conversas", async () => {
    fingirFetch([{ status: 400, corpo: { message: "Enable NOWEB store" } }]);
    await expect(waha.listChatsOverview("s", { limit: 5, offset: 0 })).rejects.toBeInstanceOf(
      WahaStoreDesligadoError,
    );
  });

  it("400 por outro motivo NÃO é tratado como 'armazenamento desligado'", async () => {
    fingirFetch([{ status: 400, corpo: { message: "limit must be a number" } }]);
    const r = waha.listContacts("s", { limit: 5, offset: 0 });
    await expect(r).rejects.not.toBeInstanceOf(WahaStoreDesligadoError);
    await expect(r).rejects.toThrow(/waha_400/);
  });

  it("pede a página certa, com a sessão codificada", async () => {
    const chamadas = fingirFetch([{ status: 200, corpo: [] }]);
    await waha.listContacts("org a/b", { limit: 1000, offset: 2000 });
    expect(chamadas[0]?.url).toBe(
      "http://waha:3000/api/contacts/all?session=org%20a%2Fb&limit=1000&offset=2000",
    );
  });

  it("resposta que não é lista vira lista vazia", async () => {
    fingirFetch([{ status: 200, corpo: { inesperado: true } }]);
    await expect(waha.listChatsOverview("s", { limit: 5, offset: 0 })).resolves.toEqual([]);
  });
});
