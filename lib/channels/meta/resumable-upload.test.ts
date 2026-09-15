import { describe, expect, it, vi } from "vitest";

import { uploadMediaHandle } from "./resumable-upload";

/**
 * Migration 0172 — o bug que motivou este módulo: template com imagem no
 * cabeçalho sempre falhava porque `header_handle` recebia uma URL do nosso
 * Storage em vez de um HANDLE da Resumable Upload API. Estes testes provam
 * o fluxo de dois passos (abrir sessão → subir bytes) sem bater na Meta de
 * verdade.
 */
function fetchMock(respostas: Array<{ ok: boolean; status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = respostas[i++]!;
    return {
      ok: r.ok,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    } as Response;
  });
}

describe("uploadMediaHandle", () => {
  it("⭐ dois passos: abre sessão em /{app_id}/uploads, sobe bytes na sessão devolvida, retorna o handle", async () => {
    const fetchImpl = fetchMock([
      { ok: true, status: 200, body: { id: "upload:sessao123" } },
      { ok: true, status: 200, body: { h: "4:foto.jpg:image/jpeg:ARaXYZ" } },
    ]);

    const r = await uploadMediaHandle(
      {
        appId: "app-1",
        token: "token-xyz",
        fileName: "foto.jpg",
        mime: "image/jpeg",
        bytes: new Uint8Array([1, 2, 3]),
      },
      { fetchImpl },
    );

    expect(r).toEqual({ status: "ok", handle: "4:foto.jpg:image/jpeg:ARaXYZ" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [primeiraUrl, primeiraInit] = fetchImpl.mock.calls[0]!;
    expect(String(primeiraUrl)).toContain("/app-1/uploads");
    expect(String(primeiraUrl)).toContain("file_type=image%2Fjpeg");
    expect((primeiraInit as RequestInit).method).toBe("POST");
    expect((primeiraInit as RequestInit).headers).toMatchObject({ Authorization: "OAuth token-xyz" });

    const [segundaUrl, segundaInit] = fetchImpl.mock.calls[1]!;
    expect(String(segundaUrl)).toContain("upload:sessao123");
    expect((segundaInit as RequestInit).headers).toMatchObject({
      Authorization: "OAuth token-xyz",
      file_offset: "0",
    });
    // Os bytes crus, não multipart/base64 — provado com detalhe no teste seguinte.
    expect((segundaInit as RequestInit).body).toBeInstanceOf(Uint8Array);
  });

  it("passa os BYTES crus como corpo da 2ª chamada — não multipart, não base64", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const fetchImpl = fetchMock([
      { ok: true, status: 200, body: { id: "upload:s1" } },
      { ok: true, status: 200, body: { h: "handle-1" } },
    ]);
    await uploadMediaHandle(
      { appId: "a", token: "t", fileName: "f.png", mime: "image/png", bytes },
      { fetchImpl },
    );
    const segundaInit = fetchImpl.mock.calls[1]![1] as { body?: unknown };
    expect(segundaInit.body).toBe(bytes);
  });

  it("sessão que falha (400) não tenta o 2º passo, e devolve o erro da Meta", async () => {
    const fetchImpl = fetchMock([
      { ok: false, status: 400, body: { error: { message: "Invalid access token" } } },
    ]);
    const r = await uploadMediaHandle(
      { appId: "a", token: "t-invalido", fileName: "f.jpg", mime: "image/jpeg", bytes: new Uint8Array() },
      { fetchImpl },
    );
    expect(r.status).toBe("failed");
    expect(r.error).toContain("Invalid access token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sessão ok mas upload final falha — erro reporta a ETAPA (upload), não confunde com a sessão", async () => {
    const fetchImpl = fetchMock([
      { ok: true, status: 200, body: { id: "upload:s2" } },
      { ok: false, status: 500, body: { error: { message: "server error" } } },
    ]);
    const r = await uploadMediaHandle(
      { appId: "a", token: "t", fileName: "f.jpg", mime: "image/jpeg", bytes: new Uint8Array([1]) },
      { fetchImpl },
    );
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^upload /);
  });

  it("exceção de rede (fetch rejeita) vira `failed`, não propaga", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await uploadMediaHandle(
      { appId: "a", token: "t", fileName: "f.jpg", mime: "image/jpeg", bytes: new Uint8Array() },
      { fetchImpl },
    );
    expect(r).toEqual({ status: "failed", error: "network down" });
  });
});
