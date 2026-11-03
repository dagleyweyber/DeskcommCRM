import { describe, expect, it } from "vitest";

import { contatosDoCanal, PAGINA } from "./contatos-do-canal";

type Chamada = { filtros: Array<[string, unknown]>; de: number; ate: number };

/** Banco falso: `total` conversas, devolvidas em fatias pelo `range`, como o PostgREST faz. */
function bancoFalso(total: number, opcoes: { embedComoArray?: boolean; erro?: string } = {}) {
  const chamadas: Chamada[] = [];
  const supabase = {
    from: (tabela: string) => {
      expect(tabela).toBe("conversations");
      const filtros: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: unknown) => {
        filtros.push([col, v]);
        return q;
      };
      q.order = () => q;
      q.range = async (de: number, ate: number) => {
        chamadas.push({ filtros, de, ate });
        if (opcoes.erro) return { data: null, error: { message: opcoes.erro } };
        const fim = Math.min(ate + 1, total);
        const linhas = [];
        for (let i = de; i < fim; i += 1) {
          const contato = { name: `C${i}`, phone_number: `+55${i}`, tags: [], consent: {} };
          linhas.push({
            created_at: "2026-11-01T00:00:00Z",
            last_message_at: "2026-11-02T00:00:00Z",
            contacts: opcoes.embedComoArray ? [contato] : contato,
          });
        }
        return { data: linhas, error: null };
      };
      return q;
    },
  };
  return { supabase: supabase as never, chamadas };
}

describe("contatosDoCanal", () => {
  it("⭐ pagina: mais de 1000 contatos NÃO são cortados em silêncio", async () => {
    const { supabase, chamadas } = bancoFalso(PAGINA * 2 + 345);
    const r = await contatosDoCanal(supabase, "org-1", "sess-1");
    expect(r).toHaveLength(PAGINA * 2 + 345);
    expect(chamadas.map((c) => [c.de, c.ate])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("página cheia seguida de página vazia termina sem laço infinito", async () => {
    const { supabase, chamadas } = bancoFalso(PAGINA);
    expect(await contatosDoCanal(supabase, "o", "s")).toHaveLength(PAGINA);
    expect(chamadas).toHaveLength(2);
  });

  it("⭐ filtra por organização, canal, sem grupo e sem anonimizado", async () => {
    const { supabase, chamadas } = bancoFalso(1);
    await contatosDoCanal(supabase, "org-1", "sess-1");
    expect(chamadas[0]!.filtros).toEqual([
      ["organization_id", "org-1"],
      ["channel_session_id", "sess-1"],
      ["is_group", false],
      ["contacts.is_anonymized", false],
    ]);
  });

  it("aceita o embed como objeto ou como array", async () => {
    const { supabase } = bancoFalso(2, { embedComoArray: true });
    const r = await contatosDoCanal(supabase, "o", "s");
    expect(r.map((l) => l.contato.name)).toEqual(["C0", "C1"]);
    expect(r[0]).toMatchObject({
      primeira_conversa_em: "2026-11-01T00:00:00Z",
      ultima_mensagem_em: "2026-11-02T00:00:00Z",
    });
  });

  it("erro do banco vira exceção, não CSV vazio com cara de sucesso", async () => {
    const { supabase } = bancoFalso(1, { erro: "boom" });
    await expect(contatosDoCanal(supabase, "o", "s")).rejects.toThrow("boom");
  });
});
