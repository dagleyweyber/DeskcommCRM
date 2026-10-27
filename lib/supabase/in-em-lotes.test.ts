import { describe, expect, it } from "vitest";

import { consultaEmLotes, emLotes, IDS_POR_LOTE } from "./in-em-lotes";

/** UUID no formato real (36 caracteres), o que o PostgREST recebe na URL. */
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/**
 * Achado ao vivo (B'laser Caruaru): `.in()` com ~400 ids estoura a URL (~15 KB) e a
 * consulta falha com "TypeError: fetch failed".
 */
describe("emLotes", () => {
  it("parte a lista em lotes do tamanho pedido, sem perder nem repetir item", () => {
    const itens = Array.from({ length: 1000 }, (_, i) => i);
    const lotes = emLotes(itens, 150);
    expect(lotes).toHaveLength(7);
    expect(lotes.every((l) => l.length <= 150)).toBe(true);
    expect(lotes.flat()).toEqual(itens);
  });

  it("lista vazia → nenhum lote; lista menor que o lote → um lote só", () => {
    expect(emLotes([])).toEqual([]);
    expect(emLotes([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("⭐ nenhum lote gera URL perto do limite medido (~15 KB), mesmo com 5.000 ids", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => uuid(i));
    for (const lote of emLotes(ids)) {
      const url = `lead_state?select=contact_id&organization_id=eq.${uuid(0)}&contact_id=in.(${lote.join(",")})`;
      expect(url.length).toBeLessThan(8_000);
    }
  });

  it("tamanho inválido é recusado em vez de entrar em laço infinito", () => {
    expect(() => emLotes([1], 0)).toThrow();
    expect(() => emLotes([1], 1.5)).toThrow();
  });
});

describe("consultaEmLotes", () => {
  it("⭐ funil de 397 leads (o da Caruaru): várias consultas, cada uma pequena, todas as linhas de volta", async () => {
    const ids = Array.from({ length: 397 }, (_, i) => uuid(i));
    const tamanhos: number[] = [];

    const r = await consultaEmLotes(ids, async (lote) => {
      tamanhos.push(lote.length);
      return { data: lote.map((id) => ({ id })), error: null };
    });

    expect(r.error).toBeNull();
    expect(r.data.map((x) => x.id).sort()).toEqual([...ids].sort());
    expect(tamanhos.length).toBeGreaterThan(1);
    expect(Math.max(...tamanhos)).toBeLessThanOrEqual(IDS_POR_LOTE);
  });

  it("sem ids não faz consulta nenhuma", async () => {
    let chamadas = 0;
    const r = await consultaEmLotes([], async () => {
      chamadas += 1;
      return { data: [], error: null };
    });
    expect(chamadas).toBe(0);
    expect(r).toEqual({ data: [], error: null });
  });

  it("⭐ falha em UM lote falha o conjunto — nada de resultado parcial calado", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => uuid(i));
    let n = 0;
    const r = await consultaEmLotes(ids, async (lote) => {
      n += 1;
      if (n === 2) return { data: null, error: { message: "boom" } };
      return { data: lote.map((id) => ({ id })), error: null };
    });
    expect(r.error).toEqual({ message: "boom" });
    expect(r.data).toEqual([]);
  });

  it("data nula num lote sem erro conta como zero linhas", async () => {
    const r = await consultaEmLotes(["a", "b"], async () => ({ data: null, error: null }));
    expect(r).toEqual({ data: [], error: null });
  });

  it("⭐ a ordem DENTRO de cada lote é preservada (a conversa mais recente de cada contato continua a primeira)", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => uuid(i));
    const r = await consultaEmLotes(ids, async (lote) => ({
      // devolve os ids do lote em ordem inversa, como um `order by … desc`
      data: [...lote].reverse().map((id) => ({ id })),
      error: null,
    }));
    const primeiroDeCadaLote = [r.data[0]!.id, r.data[150]!.id];
    expect(primeiroDeCadaLote).toEqual([ids[149], ids[299]]);
  });
});
