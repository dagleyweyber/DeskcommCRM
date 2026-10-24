import { describe, expect, it } from "vitest";

import { ORIGEM_HISTORICO, reabrirConversaImportada } from "./conversa-importada";

function adminComRpc(resposta: { data: unknown; error: { message: string } | null }) {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  return {
    chamadas,
    admin: {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chamadas.push({ nome, args });
        return resposta;
      },
    } as never,
  };
}

describe("reabrirConversaImportada", () => {
  it("chama a função SQL atômica com o id da conversa e devolve true quando reabriu", async () => {
    const { admin, chamadas } = adminComRpc({ data: true, error: null });
    expect(await reabrirConversaImportada(admin, "conv-1")).toBe(true);
    expect(chamadas).toEqual([{ nome: "fn_reabrir_conversa_importada", args: { p_conv: "conv-1" } }]);
  });

  it("conversa que não era importada (ou já reaberta): false, sem erro", async () => {
    const { admin } = adminComRpc({ data: false, error: null });
    expect(await reabrirConversaImportada(admin, "conv-1")).toBe(false);
  });

  it("⭐ falha da reabertura NÃO derruba a ingestão — devolve false e segue", async () => {
    const { admin } = adminComRpc({ data: null, error: { message: "boom" } });
    await expect(reabrirConversaImportada(admin, "conv-1")).resolves.toBe(false);
  });

  it("a marca é a MESMA string que as migrations 0196 e 0197 leem", () => {
    expect(ORIGEM_HISTORICO).toBe("historico_importado");
  });
});
