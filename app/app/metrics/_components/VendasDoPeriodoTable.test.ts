import { describe, expect, it } from "vitest";

import { formatCurrency, formatDate, formatDias } from "./VendasDoPeriodoTable";

/**
 * Lista de vendas do período (migration 0173) — pedido ao vivo (RevitaFio
 * Mossoró) inspirado numa lista parecida de outra ferramenta.
 */
describe("formatCurrency", () => {
  it("centavos vira reais formatado", () => {
    // Espaço entre "R$" e o valor: `Intl.NumberFormat` usa NBSP (U+00A0) em
    // algumas versões de ICU/Node e espaço comum em outras — normaliza antes
    // de comparar pra o teste não depender de qual ICU rodou.
    expect(formatCurrency(450_000).replace(/\s/g, " ")).toBe("R$ 4.500,00");
  });

  it("⭐ null (lead fechado sem valor) vira travessão, não R$ 0,00", () => {
    expect(formatCurrency(null)).toBe("—");
  });
});

describe("formatDate", () => {
  it("yyyy-mm-dd vira dia/mês curto em pt-BR", () => {
    const out = formatDate("2026-09-15");
    expect(out).toContain("15");
    expect(out.toLowerCase()).toContain("set");
  });
});

describe("formatDias", () => {
  it("1 dia fica no singular", () => {
    expect(formatDias(1)).toBe("1 dia");
  });

  it("0 e outros valores ficam no plural", () => {
    expect(formatDias(0)).toBe("0 dias");
    expect(formatDias(92)).toBe("92 dias");
  });
});
