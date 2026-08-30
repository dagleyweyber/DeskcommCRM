"use client";
import { useEffect, useState } from "react";
import { MagnifyingGlass, UserCheck } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty";
import { useCustomerList } from "@/hooks/customers/useCustomerList";
import { CustomersTable } from "@/components/customers/CustomersTable";

export function CustomersListClient() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce search 250ms — mesmo padrão de Contatos.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const q = useCustomerList(search);
  const customers = q.data?.data ?? [];

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
        <p className="text-sm text-muted-foreground">
          Todo contato que já comprou ou foi reconhecido como cliente já existente.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Buscar por nome, email ou telefone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 w-72 pl-8"
          />
        </div>
      </div>

      {q.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">Erro ao carregar clientes.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>
            Tentar novamente
          </Button>
        </Card>
      ) : customers.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={UserCheck}
            headline={search ? "Nenhum cliente encontrado" : "Ainda não há clientes"}
            subcopy={
              search
                ? "Tente buscar por outro nome, email ou telefone."
                : "Um lead vira cliente quando fecha uma venda pela primeira vez, ou quando alguém do time marca \"Cliente já existente\" no card do kanban."
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CustomersTable customers={customers} />
        </Card>
      )}
    </div>
  );
}
