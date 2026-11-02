import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

import { importLoteSchema, importarLoteHandler } from "@/app/api/v1/contacts/import/_handler";

const IMPORT_ID = "6b1f3f1e-8c1a-4c55-9a43-1f2b3c4d5e6f";
const ctx = { organization_id: "org-1", actor: { type: "user" as const, id: "user-1" }, requestId: "req-1" };

function supabaseFalso(linhasDoBanco: unknown[]) {
  const rpc = vi.fn().mockResolvedValue({ data: linhasDoBanco, error: null });
  return { rpc, cliente: { rpc } as never };
}

beforeEach(() => auditMock.mockReset());

describe("POST /api/v1/contacts/import — o servidor refaz a prévia do navegador", () => {
  it("⭐ normaliza o telefone de novo e manda as variantes do 9º dígito ao banco", async () => {
    const { rpc, cliente } = supabaseFalso([{ linha: 2, resultado: "criado", motivo: null, contact_id: "c1" }]);
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      tags: [" base 2024 "],
      consentimento_marketing: true,
      linhas: [{ linha: 2, telefone: "(81) 99184-0070", nome: "Vivi", email: "VIVI@X.COM" }],
    });
    await importarLoteHandler(cliente, ctx, input);

    const [fn, args] = rpc.mock.calls[0]!;
    expect(fn).toBe("fn_importar_contatos");
    expect(args).toMatchObject({
      p_org: "org-1",
      p_tags: ["base 2024"],
      p_consentir: true,
      p_origem: { import_id: IMPORT_ID },
    });
    expect(args.p_linhas).toEqual([
      {
        linha: 2,
        telefone: "+5581991840070",
        variantes: ["+5581991840070", "+558191840070"],
        nome: "Vivi",
        email: "vivi@x.com",
        tags: [],
      },
    ]);
  });

  it("⭐ organização vem do contexto autenticado — nunca do corpo", async () => {
    const { rpc, cliente } = supabaseFalso([]);
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      consentimento_marketing: false,
      linhas: [{ linha: 2, telefone: "81991840070" }],
      organization_id: "org-intrusa",
    });
    await importarLoteHandler(cliente, ctx, input);
    expect(rpc.mock.calls[0]![1].p_org).toBe("org-1");
  });

  it("telefone que não serve nem chega ao banco e vira aviso com a linha", async () => {
    const { rpc, cliente } = supabaseFalso([]);
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      consentimento_marketing: true,
      linhas: [{ linha: 7, telefone: "5,58E+12" }],
    });
    const r = await importarLoteHandler(cliente, ctx, input);
    expect(rpc).not.toHaveBeenCalled();
    expect(r).toEqual({
      criados: 0,
      atualizados: 0,
      ignorados: 1,
      avisos: [{ linha: 7, resultado: "ignorado", motivo: "telefone_cientifico" }],
    });
  });

  it("soma o resultado do banco e devolve só o que pede atenção", async () => {
    const { cliente } = supabaseFalso([
      { linha: 2, resultado: "criado", motivo: null, contact_id: "a" },
      { linha: 3, resultado: "atualizado", motivo: null, contact_id: "b" },
      { linha: 4, resultado: "atualizado", motivo: "bloqueado", contact_id: "c" },
      { linha: 5, resultado: "ignorado", motivo: "anonimizado", contact_id: "d" },
    ]);
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      consentimento_marketing: true,
      linhas: [2, 3, 4, 5].map((linha) => ({ linha, telefone: `8199184007${linha}` })),
    });
    const r = await importarLoteHandler(cliente, ctx, input);
    expect(r).toMatchObject({ criados: 1, atualizados: 2, ignorados: 1 });
    expect(r.avisos.map((a) => a.motivo)).toEqual(["bloqueado", "anonimizado"]);
  });

  it("⭐ um audit por LOTE (não por contato), com o import_id que agrupa a planilha", async () => {
    const { cliente } = supabaseFalso([{ linha: 2, resultado: "criado", motivo: null, contact_id: "a" }]);
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      file_name: "base.xlsx",
      consentimento_marketing: true,
      linhas: [{ linha: 2, telefone: "81991840070" }],
    });
    await importarLoteHandler(cliente, ctx, input);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      action: "contacts.imported",
      organizationId: "org-1",
      resourceId: IMPORT_ID,
      metadata: { file_name: "base.xlsx", criados: 1 },
    });
  });

  it("e-mail inválido não derruba o lote: vira null", () => {
    const input = importLoteSchema.parse({
      import_id: IMPORT_ID,
      consentimento_marketing: true,
      linhas: [{ linha: 2, telefone: "81991840070", email: "nao-e-email" }],
    });
    expect(input.linhas[0]!.email).toBeNull();
  });

  it("lote acima de 500 linhas é recusado na validação", () => {
    const r = importLoteSchema.safeParse({
      import_id: IMPORT_ID,
      consentimento_marketing: true,
      linhas: Array.from({ length: 501 }, (_, i) => ({ linha: i + 2, telefone: "81991840070" })),
    });
    expect(r.success).toBe(false);
  });
});
