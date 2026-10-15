"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import { TenantsFilters } from "@/components/admin/tenants/TenantsFilters";
import {
  TenantsTable,
  TenantsTableSkeleton,
} from "@/components/admin/tenants/TenantsTable";
import { useAdminTenants, type AdminTenantsFilters } from "@/hooks/useAdminTenants";

export function TenantsClient() {
  const [filters, setFilters] = useState<AdminTenantsFilters>({});

  const { data, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminTenants(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Carregando..." : `${total} tenant${total !== 1 ? "s" : ""}${hasNextPage ? "+" : ""}`}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/tenants/new">
            <Plus size={16} aria-hidden />
            Novo tenant
          </Link>
        </Button>
      </div>

      {/* Filters */}
      <TenantsFilters filters={filters} onChange={setFilters} />

      {/* Table */}
      {isError ? (
        // Achado ao vivo: um erro do backend (filtro mal formado, etc.)
        // virava "Nenhum tenant encontrado" na tela — indistinguível de uma
        // busca que genuinamente não achou nada. Erro de busca precisa dizer
        // que é erro, não fingir lista vazia.
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Falha ao buscar tenants
          {error instanceof Error ? `: ${error.message}` : "."}
        </p>
      ) : isLoading ? (
        <TenantsTableSkeleton />
      ) : (
        <TenantsTable
          data={rows}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
