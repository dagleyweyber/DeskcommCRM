import { describe, expect, it } from "vitest";

import { fraseDaContagem } from "@/app/app/campaigns/_components/NovaCampanhaForm";

import { aplicarRegrasDeEnvio, recortarPublico, regrasDeEnvioSchema } from "./regras-de-envio";

const membro = (id: string) => ({ contactId: id, leadId: null, displayName: id });
const publico = ["a", "b", "c", "d", "e"].map(membro);

describe("recortarPublico", () => {
  it("tira quem já recebeu e depois aplica o teto", () => {
    const r = recortarPublico(publico, new Set(["b", "d"]), 2);
    expect(r.selecionados.map((m) => m.contactId)).toEqual(["a", "c"]);
    expect(r).toMatchObject({ doFiltro: 5, excluidosPorRecente: 2, cortadosPeloLimite: 1 });
  });

  it("sem regras, passa todo mundo", () => {
    const r = recortarPublico(publico, new Set(), null);
    expect(r.selecionados).toHaveLength(5);
    expect(r).toMatchObject({ excluidosPorRecente: 0, cortadosPeloLimite: 0 });
  });

  it("segunda leva: mesma lista, quem recebeu na primeira fica de fora", () => {
    const primeira = recortarPublico(publico, new Set(), 3).selecionados.map((m) => m.contactId);
    const segunda = recortarPublico(publico, new Set(primeira), 3).selecionados.map((m) => m.contactId);
    expect(segunda).toEqual(["d", "e"]);
  });
});

/** Admin falso: devolve as linhas da tabela pedida e guarda os filtros usados. */
function adminFalso(tabelas: Record<string, unknown[]>) {
  const chamadas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  return {
    chamadas,
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      chamadas.push({ tabela, filtros });
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push([`eq:${c}`, v]), q),
        gte: (c: string, v: unknown) => (filtros.push([`gte:${c}`, v]), q),
        in: (c: string, v: unknown) => (filtros.push([`in:${c}`, v]), q),
        order: () => q,
        range: () => q,
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => {
          const status = filtros.find(([c]) => c === "eq:status")?.[1];
          const linhas = (tabelas[tabela] ?? []).filter(
            (l) => status === undefined || (l as { status?: string }).status === status,
          );
          return Promise.resolve({ data: linhas, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

describe("aplicarRegrasDeEnvio", () => {
  it("janela de 2 dias consulta envios desde agora menos 48h, e soma a fila das campanhas em andamento", async () => {
    const admin = adminFalso({
      whatsapp_campaign_recipients: [
        { contact_id: "a", status: "sent" },
        { contact_id: "c", status: "pending" },
      ],
      whatsapp_campaigns: [{ id: "camp-1" }],
    });
    const agora = new Date("2026-11-08T12:00:00Z");
    const r = await aplicarRegrasDeEnvio(
      admin as never,
      "org-1",
      publico,
      { excluirQuemRecebeuDias: 2, limite: null },
      agora,
    );
    expect(r.selecionados.map((m) => m.contactId)).toEqual(["b", "d", "e"]);
    const enviados = admin.chamadas[0]!.filtros;
    expect(enviados).toContainEqual(["gte:sent_at", "2026-11-06T12:00:00.000Z"]);
    expect(enviados).toContainEqual(["eq:organization_id", "org-1"]);
    expect(admin.chamadas[1]!.filtros).toContainEqual(["in:status", ["queued", "running", "paused"]]);
  });

  it("sem janela, não lê o banco", async () => {
    const admin = adminFalso({});
    await aplicarRegrasDeEnvio(admin as never, "org-1", publico, { limite: 2 });
    expect(admin.chamadas).toHaveLength(0);
  });
});

describe("regrasDeEnvioSchema", () => {
  it("aceita só as janelas oferecidas", () => {
    expect(regrasDeEnvioSchema.safeParse({ excluir_quem_recebeu_dias: 3 }).success).toBe(true);
    expect(regrasDeEnvioSchema.safeParse({ excluir_quem_recebeu_dias: 5 }).success).toBe(false);
    expect(regrasDeEnvioSchema.safeParse({ limite: 0 }).success).toBe(false);
  });
});

describe("fraseDaContagem", () => {
  it("explica por que saiu menos que o filtro", () => {
    expect(
      fraseDaContagem({ total: 1000, do_filtro: 2000, excluidos_por_recente: 400, cortados_pelo_limite: 600 }),
    ).toBe("Vai sair para 1.000 de 2.000 contatos — 400 já receberam, 600 ficam para a próxima.");
  });
});
