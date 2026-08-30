"use client";
import Link from "next/link";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Customer } from "@/app/api/v1/customers/route";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

interface Props {
  customers: Customer[];
}

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function CustomersTable({ customers }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nome</TableHead>
          <TableHead>Telefone</TableHead>
          <TableHead>Cliente desde</TableHead>
          <TableHead>Compras</TableHead>
          <TableHead>LTV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.map((c) => (
          <TableRow key={c.id} className="cursor-pointer">
            <TableCell className="font-medium">
              <Link href={`/app/contacts/${c.id}`} className="hover:underline">
                {rotuloDoContato(c)}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{c.phone_number ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {format(new Date(c.became_customer_at), "dd/MM/yyyy", { locale: ptBR })}
            </TableCell>
            <TableCell className="tabular-nums">{c.purchase_count}</TableCell>
            <TableCell className="tabular-nums">
              {c.purchase_count > 0 ? formatCurrency(c.ltv_cents) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
