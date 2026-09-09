"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePurchases } from "@/hooks/contacts/usePurchases";

function formatBRL(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const code = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * Resumo de compras na Visão geral do contato — pedido explícito do dono da
 * agência: quem compra 2, 3, 4+ vezes precisa ver data/valor/produto de cada
 * uma num lugar só, sem separar compra de mensagem no meio da timeline.
 *
 * Some sozinho quando não há compra nenhuma — mesma filosofia de
 * `PropostasDeDado` nesta mesma tela: elemento sem conteúdo não ocupa espaço
 * pedindo atenção por nada.
 */
export function PurchaseHistory({ contactId }: { contactId: string }) {
  const q = usePurchases(contactId);
  const purchases = q.data?.data.purchases ?? [];

  if (q.isLoading || purchases.length === 0) return null;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium">Histórico de compras</h2>
      <div className="mt-3 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead className="text-right">Valor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purchases.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {p.closed_at ? format(new Date(p.closed_at), "dd/MM/yyyy", { locale: ptBR }) : "—"}
                </TableCell>
                <TableCell>{p.produto ?? "Não informado"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBRL(p.value_cents, p.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
