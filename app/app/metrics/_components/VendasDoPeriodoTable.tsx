"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { VendaDoLead } from "@/hooks/metrics/useSalesDashboard";

/**
 * Uma linha por lead vendido no período — pedido ao vivo (RevitaFio
 * Mossoró) inspirado numa lista parecida de outra ferramenta. Rolagem
 * PRÓPRIA (`max-h` + `overflow-y-auto`, não a da página) pra caber ao lado
 * dos gráficos sem esticar o card quando o período tem muita venda.
 *
 * Reaproveita o MESMO filtro do cabeçalho do relatório — não é consulta
 * própria, é um campo a mais na resposta de `fn_sales_dashboard`
 * (`vendas_lista`), então nunca diverge do que os KPIs já mostram.
 */
export function formatCurrency(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export function formatDias(dias: number): string {
  return dias === 1 ? "1 dia" : `${dias.toLocaleString("pt-BR")} dias`;
}

interface Props {
  dados: VendaDoLead[];
}

export function VendasDoPeriodoTable({ dados }: Props) {
  if (dados.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        Nenhuma venda no período
      </div>
    );
  }

  return (
    <div className="max-h-80 overflow-y-auto overflow-x-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Serviço</TableHead>
            <TableHead className="text-right">Valor</TableHead>
            <TableHead>Data</TableHead>
            <TableHead>Conversão</TableHead>
            <TableHead className="text-right">Decisão</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dados.map((v) => (
            <TableRow key={v.lead_id}>
              <TableCell className="max-w-[160px] truncate font-medium" title={v.nome}>
                {v.nome}
              </TableCell>
              <TableCell className="max-w-[140px] truncate text-muted-foreground" title={v.servico}>
                {v.servico}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(v.valor_cents)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(v.data)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(v.data_conversao)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatDias(v.tempo_decisao_dias)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
