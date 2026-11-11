import { describe, expect, it } from "vitest";

import { descreverUsos, usosDoModelo } from "./apagar-modelo";
import { semOsApagados, type MetaTemplateRow } from "./template-sync";

type Linha = Record<string, unknown>;

/** Admin falso: aplica `eq`, `is null` e `not in` de verdade sobre linhas em memória. */
function adminCom(tabelas: Record<string, Linha[]>) {
  return {
    from(tabela: string) {
      let linhas = [...(tabelas[tabela] ?? [])];
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          linhas = linhas.filter((l) => l[col] === v);
          return q;
        },
        is: (col: string, v: null) => {
          linhas = linhas.filter((l) => (l[col] ?? null) === v);
          return q;
        },
        not: (col: string, _op: string, lista: string) => {
          const fora = lista.replace(/[()]/g, "").split(",");
          linhas = linhas.filter((l) => !fora.includes(String(l[col])));
          return q;
        },
        then: (ok: (r: { data: Linha[]; error: null }) => unknown) => Promise.resolve(ok({ data: linhas, error: null })),
      };
      return q;
    },
  } as never;
}

const ORG = "org-1";

describe("usosDoModelo — o que impede apagar", () => {
  it("automação em qualquer status conta (pausada volta a enviar com um clique)", async () => {
    const admin = adminCom({
      whatsapp_template_automations: [
        { id: "a1", organization_id: ORG, template_name: "confirma", name: "Confirmação Laser", status: "paused" },
        { id: "a2", organization_id: ORG, template_name: "outro", name: "Outra", status: "active" },
        { id: "a3", organization_id: "org-2", template_name: "confirma", name: "De outro tenant", status: "active" },
      ],
      whatsapp_campaigns: [],
    });
    const usos = await usosDoModelo(admin, ORG, "confirma");
    expect(usos).toEqual([{ tipo: "automacao", id: "a1", nome: "Confirmação Laser", status: "paused" }]);
  });

  it("⭐ automação EXCLUÍDA (archived_at) não segura o modelo — ela nunca mais envia", async () => {
    const admin = adminCom({
      whatsapp_template_automations: [
        { id: "a1", organization_id: ORG, template_name: "confirma", name: "Antiga", status: "paused", archived_at: "2026-11-10T00:00:00Z" },
        { id: "a2", organization_id: ORG, template_name: "confirma", name: "Atual", status: "active", archived_at: null },
      ],
      whatsapp_campaigns: [],
    });
    const usos = await usosDoModelo(admin, ORG, "confirma");
    expect(usos.map((u) => u.id)).toEqual(["a2"]);
  });

  it("campanha encerrada ou cancelada não segura; rascunho, fila e pausada seguram", async () => {
    const admin = adminCom({
      whatsapp_template_automations: [],
      whatsapp_campaigns: [
        { id: "c1", organization_id: ORG, template_name: "promo", name: "Black", status: "completed" },
        { id: "c2", organization_id: ORG, template_name: "promo", name: "Velha", status: "cancelled" },
        { id: "c3", organization_id: ORG, template_name: "promo", name: "11.11", status: "draft" },
        { id: "c4", organization_id: ORG, template_name: "promo", name: "Reenvio", status: "paused" },
      ],
    });
    const usos = await usosDoModelo(admin, ORG, "promo");
    expect(usos.map((u) => u.id).sort()).toEqual(["c3", "c4"]);
  });

  it("sem uso, lista vazia — o apagar segue", async () => {
    const admin = adminCom({ whatsapp_template_automations: [], whatsapp_campaigns: [] });
    expect(await usosDoModelo(admin, ORG, "livre")).toEqual([]);
  });

  it("a frase da tela nomeia cada uso", () => {
    expect(
      descreverUsos([
        { tipo: "automacao", id: "a", nome: "Confirmação Laser", status: "active" },
        { tipo: "campanha", id: "c", nome: "11.11", status: "draft" },
      ]),
    ).toBe(
      'Em uso por: automação "Confirmação Laser", campanha "11.11". Troque o modelo ou exclua esses itens antes de apagar.',
    );
  });
});

describe("semOsApagados — o modelo apagado não volta no sincronizar", () => {
  const linha = (name: string, status: string) => ({ name, language: "pt_BR", status }) as MetaTemplateRow;

  it("tira PENDING_DELETION e DELETED, mantém o resto", () => {
    const rows = [linha("a", "APPROVED"), linha("b", "PENDING_DELETION"), linha("c", "DELETED"), linha("d", "REJECTED")];
    expect(semOsApagados(rows).map((r) => r.name)).toEqual(["a", "d"]);
  });
});
