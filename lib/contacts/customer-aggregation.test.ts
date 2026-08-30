import { describe, it, expect } from "vitest";

import { agregarComprasPorContato } from "./customer-aggregation";

describe("agregarComprasPorContato", () => {
  it("⭐ 2 vendas do mesmo contato: soma o LTV e conta as duas compras", () => {
    const mapa = agregarComprasPorContato([
      { contact_id: "C1", value_cents: 100_000 },
      { contact_id: "C1", value_cents: 50_000 },
    ]);
    expect(mapa.get("C1")).toEqual({ ltv_cents: 150_000, purchase_count: 2 });
  });

  it("contatos diferentes ficam em entradas separadas, sem misturar", () => {
    const mapa = agregarComprasPorContato([
      { contact_id: "C1", value_cents: 100_000 },
      { contact_id: "C2", value_cents: 200_000 },
    ]);
    expect(mapa.get("C1")).toEqual({ ltv_cents: 100_000, purchase_count: 1 });
    expect(mapa.get("C2")).toEqual({ ltv_cents: 200_000, purchase_count: 1 });
  });

  it("contact_id nulo é ignorado, não quebra nem vira entrada fantasma", () => {
    const mapa = agregarComprasPorContato([{ contact_id: null, value_cents: 100_000 }]);
    expect(mapa.size).toBe(0);
  });

  it("value_cents nulo conta como 0 no LTV, mas ainda soma a compra", () => {
    const mapa = agregarComprasPorContato([{ contact_id: "C1", value_cents: null }]);
    expect(mapa.get("C1")).toEqual({ ltv_cents: 0, purchase_count: 1 });
  });

  it("lista vazia devolve mapa vazio", () => {
    expect(agregarComprasPorContato([]).size).toBe(0);
  });
});
