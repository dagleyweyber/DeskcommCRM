"use client";
import { useMemo, useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ReceitaPorAnuncio } from "@/hooks/metrics/useSalesDashboard";

export type Nivel = "campanha" | "conjunto" | "anuncio";

const NIVEL_LABELS: Record<Nivel, string> = {
  campanha: "Campanha",
  conjunto: "Conjunto de anúncios",
  anuncio: "Anúncio",
};

export interface LinhaAgregada {
  chave: string;
  nome: string;
  leads: number;
  vendas: number;
  agendamentos: number;
  receita_cents: number;
}

/**
 * Reagrupa a MESMA lista (uma linha por anúncio, já vinda com
 * campaign_id/adset_id via cache da Fase E1/E2) pelo nível escolhido — sem
 * consulta nova nem duplicar lógica no banco. Anúncio sem hierarquia
 * resolvida ainda (Fase E2 não rodou, ou tenant sem token de leitura) cai em
 * "Sem campanha"/"Sem conjunto" em vez de sumir da agregação.
 */
export function agregarPorNivel(linhas: ReceitaPorAnuncio[], nivel: Nivel): LinhaAgregada[] {
  const grupos = new Map<string, LinhaAgregada>();

  for (const l of linhas) {
    const [chave, nome] =
      nivel === "campanha"
        ? [l.campaign_id ?? "sem-campanha", l.campaign_name ?? "Sem campanha"]
        : nivel === "conjunto"
          ? [l.adset_id ?? "sem-conjunto", l.adset_name ?? "Sem conjunto"]
          : [l.ad_id, l.anuncio];

    const atual = grupos.get(chave);
    if (atual) {
      atual.leads += l.leads;
      atual.vendas += l.vendas;
      atual.agendamentos += l.agendamentos;
      atual.receita_cents += l.receita_cents;
    } else {
      grupos.set(chave, {
        chave,
        nome,
        leads: l.leads,
        vendas: l.vendas,
        agendamentos: l.agendamentos,
        receita_cents: l.receita_cents,
      });
    }
  }

  return [...grupos.values()].sort((a, b) => b.receita_cents - a.receita_cents);
}

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatInt(n: number): string {
  return n.toLocaleString("pt-BR");
}

interface Props {
  dados: ReceitaPorAnuncio[];
}

export function AnuncioPerformanceTable({ dados }: Props) {
  const [nivel, setNivel] = useState<Nivel>("anuncio");
  const linhas = useMemo(() => agregarPorNivel(dados, nivel), [dados, nivel]);

  if (dados.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Sem dados de anúncio no período
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={nivel} onValueChange={(v) => setNivel(v as Nivel)}>
        <TabsList>
          {(Object.keys(NIVEL_LABELS) as Nivel[]).map((n) => (
            <TabsTrigger key={n} value={n}>
              {NIVEL_LABELS[n]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{NIVEL_LABELS[nivel]}</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Agendamentos</TableHead>
              <TableHead className="text-right">Vendas</TableHead>
              <TableHead className="text-right">Receita</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {linhas.map((l) => (
              <TableRow key={l.chave}>
                <TableCell className="max-w-[220px] truncate" title={l.nome}>
                  {l.nome}
                </TableCell>
                <TableCell className="text-right">{formatInt(l.leads)}</TableCell>
                <TableCell className="text-right">{formatInt(l.agendamentos)}</TableCell>
                <TableCell className="text-right">{formatInt(l.vendas)}</TableCell>
                <TableCell className="text-right">{formatCurrency(l.receita_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
