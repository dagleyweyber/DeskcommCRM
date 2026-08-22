"use client";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

import { useSalesDashboard, type SalesDashboardFiltros } from "@/hooks/metrics/useSalesDashboard";
import { KpiCard } from "./KpiCard";

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatInt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPercent(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function formatDias(dias: number | null): string {
  if (dias == null) return "—";
  return `${dias.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}

function formatDateTick(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function EmptyChart() {
  return (
    <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
      Sem dados no período
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

interface Props {
  filtros?: SalesDashboardFiltros;
}

export function SalesDashboardPanel({ filtros }: Props) {
  const { data, isLoading, isError } = useSalesDashboard(filtros);

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">Erro ao carregar o dashboard de vendas.</p>;

  const { kpis, leads_por_dia, receita_por_origem } = data.data;
  const hasLeadsPorDia = leads_por_dia.some((d) => d.criados > 0 || d.convertidos > 0);
  const hasOrigem = receita_por_origem.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiCard title="Vendas" value={formatInt(kpis.vendas)} />
        <KpiCard title="Receita Total" value={formatCurrency(kpis.receita_total_cents)} />
        <KpiCard title="Leads Totais" value={formatInt(kpis.leads_total)} />
        <KpiCard title="Conversão" value={formatPercent(kpis.conversao_pct)} />
        <KpiCard
          title="Valor Médio"
          value={kpis.valor_medio_cents == null ? "—" : formatCurrency(kpis.valor_medio_cents)}
        />
        <KpiCard title="Tempo de Conversão" value={formatDias(kpis.tempo_conversao_medio_dias)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard title="Conversão do Lead por Dia">
          {!hasLeadsPorDia ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <BarChart data={leads_por_dia} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis
                  dataKey="dia"
                  tickFormatter={formatDateTick}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={30} allowDecimals={false} />
                <Tooltip
                  formatter={(value, name) => [
                    formatInt(Number(value)),
                    name === "criados" ? "Criados" : "Convertidos",
                  ]}
                  labelFormatter={(label) => formatDateTick(String(label))}
                  contentStyle={{
                    borderRadius: "8px",
                    fontSize: "12px",
                    border: "1px solid var(--color-border)",
                  }}
                />
                <Legend
                  formatter={(value) => (value === "criados" ? "Criados" : "Convertidos")}
                  wrapperStyle={{ fontSize: "12px" }}
                />
                <Bar dataKey="criados" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="convertidos" fill="hsl(142 76% 36%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Origem do Lead e Receita">
          {!hasOrigem ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <BarChart data={receita_por_origem} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis
                  dataKey="origem"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => (v / 100).toLocaleString("pt-BR", { notation: "compact" })}
                  width={50}
                />
                <Tooltip
                  formatter={(value) => [formatCurrency(Number(value)), "Receita"]}
                  contentStyle={{
                    borderRadius: "8px",
                    fontSize: "12px",
                    border: "1px solid var(--color-border)",
                  }}
                />
                <Bar dataKey="receita_cents" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
