"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface SalesKpis {
  leads_total: number;
  vendas: number;
  receita_total_cents: number;
  valor_medio_cents: number | null;
  conversao_pct: number | null;
  tempo_conversao_medio_dias: number | null;
}

export interface LeadsPorDia {
  dia: string;
  criados: number;
  convertidos: number;
}

export interface ReceitaPorOrigem {
  origem: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}

export interface SalesDashboard {
  window: { from: string; to: string };
  kpis: SalesKpis;
  leads_por_dia: LeadsPorDia[];
  receita_por_origem: ReceitaPorOrigem[];
}

/** Dashboard de Vendas, Fase 1 — KPIs + gráficos com dado que já existe. Janela default: últimos 30 dias. */
export function useSalesDashboard() {
  return useQuery({
    queryKey: ["metrics", "sales"],
    queryFn: async () => apiClient.get<{ data: SalesDashboard }>("/api/v1/metrics/sales"),
    staleTime: 30_000,
  });
}
