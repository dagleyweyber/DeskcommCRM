import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/** Supabase falso que só registra os filtros aplicados em cada tabela. */
function supabaseFalso(contatos: Array<{ id: string }>) {
  type Chamada = [string, ...unknown[]];
  const chamadas: { conversations: Chamada[]; contacts: Chamada[] } = { conversations: [], contacts: [] };
  const construtor = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const registra = (nome: string) => (...a: unknown[]) => {
      chamadas[tabela as "conversations" | "contacts"].push([nome, ...a]);
      return q;
    };
    for (const m of ["select", "eq", "order", "limit", "not", "contains", "is", "in", "or", "ilike", "gt", "lt"]) q[m] = registra(m);
    q.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: tabela === "contacts" ? contatos : [], error: null }).then(ok);
    return q;
  };
  return { cliente: { from: construtor } as never, chamadas };
}

const ctx = { organization_id: "org-1", requestId: "r", actor: { type: "user", id: "u" } } as never;
const consulta = (search: string) => ({ limit: 30, search }) as never;

describe("busca do inbox", () => {
  it("⭐ procura por nome do contato e não só pela prévia da mensagem", async () => {
    const { cliente, chamadas } = supabaseFalso([{ id: "c-1" }, { id: "c-2" }]);
    await listConversationsHandler(cliente, ctx, consulta("Dagl"));

    const filtroContato = chamadas.contacts.find(([n]) => n === "or")?.[1] as string;
    expect(filtroContato).toContain("display_name.ilike.%Dagl%");
    expect(filtroContato).toContain("name.ilike.%Dagl%");

    const filtroConversa = chamadas.conversations.find(([n]) => n === "or")?.[1] as string;
    expect(filtroConversa).toContain("last_message_preview.ilike.%Dagl%");
    expect(filtroConversa).toContain("contact_id.in.(c-1,c-2)");
  });

  it("telefone digitado com máscara casa pelos dígitos", async () => {
    const { cliente, chamadas } = supabaseFalso([]);
    await listConversationsHandler(cliente, ctx, consulta("(81) 99999-0000"));
    const filtroContato = chamadas.contacts.find(([n]) => n === "or")?.[1] as string;
    expect(filtroContato).toContain("phone_number.ilike.%81999990000%");
  });

  it("sem contato achado, ainda busca pela prévia", async () => {
    const { cliente, chamadas } = supabaseFalso([]);
    await listConversationsHandler(cliente, ctx, consulta("orçamento"));
    const filtroConversa = chamadas.conversations.find(([n]) => n === "or")?.[1] as string;
    expect(filtroConversa).toBe("last_message_preview.ilike.%orçamento%");
  });

  it("vírgula e parêntese no termo não quebram o filtro", async () => {
    const { cliente, chamadas } = supabaseFalso([]);
    await listConversationsHandler(cliente, ctx, consulta("a,b)"));
    const filtroConversa = chamadas.conversations.find(([n]) => n === "or")?.[1] as string;
    expect(filtroConversa).toBe("last_message_preview.ilike.%a b %");
  });
});
