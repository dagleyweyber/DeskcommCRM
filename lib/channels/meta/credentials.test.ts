import { describe, expect, it, vi } from "vitest";

import { metaCredsForPhoneNumberId } from "./credentials";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "token-decifrado"),
}));

/** Client mínimo que guarda os filtros que a busca montou. */
function adminEspiao(row: Record<string, unknown> | null) {
  const filtros: Array<[string, ...unknown[]]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtros.push(["eq", col, val]);
      return chain;
    },
    is: (col: string, val: unknown) => {
      filtros.push(["is", col, val]);
      return chain;
    },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { client: { from: () => chain } as never, filtros };
}

describe("metaCredsForPhoneNumberId", () => {
  it("⭐ ignora sessão ARQUIVADA — número reconectado não pode deixar duas linhas disputando", async () => {
    // Achado ao revisar o canal oficial antes de abrir um segundo modo de
    // conexão (Embedded Signup): o delete só arquiva a sessão, o id do número
    // fica na linha, e a busca antiga não olhava `archived_at`.
    const { client, filtros } = adminEspiao({
      meta_phone_number_id: "123",
      meta_token_encrypted: "\\xdeadbeef",
    });

    await metaCredsForPhoneNumberId(client, "123");

    expect(filtros).toContainEqual(["is", "archived_at", null]);
    expect(filtros).toContainEqual(["eq", "meta_phone_number_id", "123"]);
  });

  it("devolve a credencial da sessão ativa, com a origem 'session'", async () => {
    const { client } = adminEspiao({
      meta_phone_number_id: "123",
      meta_token_encrypted: "\\xdeadbeef",
    });

    const creds = await metaCredsForPhoneNumberId(client, "123");

    expect(creds).toMatchObject({ phoneNumberId: "123", token: "token-decifrado", source: "session" });
  });

  it("sem token gravado devolve null (o chamador cai no env, não é erro)", async () => {
    const { client } = adminEspiao({ meta_phone_number_id: "123", meta_token_encrypted: null });

    expect(await metaCredsForPhoneNumberId(client, "123")).toBeNull();
  });

  it("phone_number_id vazio nem consulta o banco", async () => {
    const { client, filtros } = adminEspiao(null);

    expect(await metaCredsForPhoneNumberId(client, "")).toBeNull();
    expect(filtros).toHaveLength(0);
  });
});
