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

export interface ReceitaPorServico {
  servico: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}

export interface PrincipalObjecao {
  motivo: string;
  quantidade: number;
}

export interface FunilAgendamento {
  agendados: number;
  compareceram: number;
  nao_compareceram: number;
  compareceram_e_fecharam: number;
  taxa_comparecimento_pct: number | null;
}

export interface SalesDashboard {
  window: { from: string; to: string };
  pipeline_id: string | null;
  source: string | null;
  kpis: SalesKpis;
  leads_por_dia: LeadsPorDia[];
  receita_por_origem: ReceitaPorOrigem[];
  receita_por_servico: ReceitaPorServico[];
  principais_objecoes: PrincipalObjecao[];
  funil_agendamento: FunilAgendamento;
}

export interface SalesDashboardFiltros {
  /** ISO-8601 com offset. Ausente ⇒ a rota assume os últimos 30 dias. */
  from?: string;
  to?: string;
  pipelineId?: string;
  source?: string;
}

/** Dashboard de Vendas — KPIs + gráficos com dado que já existe. Sem filtro, últimos 30 dias, sem recorte de pipeline/origem. */
export function useSalesDashboard(filtros: SalesDashboardFiltros = {}) {
  const { from, to, pipelineId, source } = filtros;
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (pipelineId) qs.set("pipeline_id", pipelineId);
  if (source) qs.set("source", source);
  const query = qs.toString();

  return useQuery({
    queryKey: ["metrics", "sales", from ?? null, to ?? null, pipelineId ?? null, source ?? null],
    queryFn: async () =>
      apiClient.get<{ data: SalesDashboard }>(`/api/v1/metrics/sales${query ? `?${query}` : ""}`),
    staleTime: 30_000,
  });
}
