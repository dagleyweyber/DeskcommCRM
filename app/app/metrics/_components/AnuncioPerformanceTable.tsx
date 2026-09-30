"use client";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

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

interface Selecao {
  chave: string;
  nome: string;
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

/**
 * Drill-down tipo Gerenciador de Anúncios Meta: selecionar uma campanha na
 * aba "Campanha" escopa as abas "Conjunto de anúncios" e "Anúncio" só aos
 * dados dela; selecionar um conjunto escopa "Anúncio" só a ele. A seleção é
 * só um filtro pra frente (campanha → conjunto → anúncio) — nunca pra trás —
 * e trocar a campanha selecionada limpa o conjunto (ele pertencia ao
 * contexto antigo).
 */
export function AnuncioPerformanceTable({ dados }: Props) {
  const [nivel, setNivel] = useState<Nivel>("anuncio");
  const [campanhaSelecionada, setCampanhaSelecionada] = useState<Selecao | null>(null);
  const [conjuntoSelecionado, setConjuntoSelecionado] = useState<Selecao | null>(null);

  const dadosDoNivel = useMemo(() => {
    if (nivel === "campanha") return dados;
    let base = dados;
    if (campanhaSelecionada) {
      base = base.filter((l) => (l.campaign_id ?? "sem-campanha") === campanhaSelecionada.chave);
    }
    if (nivel === "anuncio" && conjuntoSelecionado) {
      base = base.filter((l) => (l.adset_id ?? "sem-conjunto") === conjuntoSelecionado.chave);
    }
    return base;
  }, [dados, nivel, campanhaSelecionada, conjuntoSelecionado]);

  const linhas = useMemo(() => agregarPorNivel(dadosDoNivel, nivel), [dadosDoNivel, nivel]);

  if (dados.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Sem dados de anúncio no período
      </div>
    );
  }

  function selecionarLinha(l: LinhaAgregada) {
    if (nivel === "campanha") {
      setCampanhaSelecionada((atual) => (atual?.chave === l.chave ? null : { chave: l.chave, nome: l.nome }));
      setConjuntoSelecionado(null);
    } else if (nivel === "conjunto") {
      setConjuntoSelecionado((atual) => (atual?.chave === l.chave ? null : { chave: l.chave, nome: l.nome }));
    }
  }

  const linhaClicavel = nivel === "campanha" || nivel === "conjunto";
  const mostraFiltroCampanha = nivel !== "campanha" && campanhaSelecionada;
  const mostraFiltroConjunto = nivel === "anuncio" && conjuntoSelecionado;

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

      {(mostraFiltroCampanha || mostraFiltroConjunto) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Filtrando por:</span>
          {mostraFiltroCampanha && (
            <Badge variant="info" className="gap-1 pr-1">
              {campanhaSelecionada!.nome}
              <button
                type="button"
                onClick={() => {
                  setCampanhaSelecionada(null);
                  setConjuntoSelecionado(null);
                }}
                aria-label={`Remover filtro de campanha ${campanhaSelecionada!.nome}`}
              >
                <X size={12} aria-hidden />
              </button>
            </Badge>
          )}
          {mostraFiltroConjunto && (
            <Badge variant="info" className="gap-1 pr-1">
              {conjuntoSelecionado!.nome}
              <button
                type="button"
                onClick={() => setConjuntoSelecionado(null)}
                aria-label={`Remover filtro de conjunto ${conjuntoSelecionado!.nome}`}
              >
                <X size={12} aria-hidden />
              </button>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => {
              setCampanhaSelecionada(null);
              setConjuntoSelecionado(null);
            }}
          >
            Limpar
          </Button>
        </div>
      )}

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
            {linhas.map((l) => {
              const selecionada =
                (nivel === "campanha" && campanhaSelecionada?.chave === l.chave) ||
                (nivel === "conjunto" && conjuntoSelecionado?.chave === l.chave);
              return (
                <TableRow
                  key={l.chave}
                  data-testid={linhaClicavel ? `linha-${nivel}-${l.chave}` : undefined}
                  className={cn(
                    linhaClicavel && "cursor-pointer",
                    selecionada && "bg-accent-soft hover:bg-accent-soft",
                  )}
                  tabIndex={linhaClicavel ? 0 : undefined}
                  role={linhaClicavel ? "button" : undefined}
                  aria-pressed={linhaClicavel ? selecionada : undefined}
                  onClick={linhaClicavel ? () => selecionarLinha(l) : undefined}
                  onKeyDown={
                    linhaClicavel
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            selecionarLinha(l);
                          }
                        }
                      : undefined
                  }
                >
                  <TableCell className="max-w-[220px] truncate" title={l.nome}>
                    {l.nome}
                  </TableCell>
                  <TableCell className="text-right">{formatInt(l.leads)}</TableCell>
                  <TableCell className="text-right">{formatInt(l.agendamentos)}</TableCell>
                  <TableCell className="text-right">{formatInt(l.vendas)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(l.receita_cents)}</TableCell>
                </TableRow>
              );
            })}
            {linhas.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                  Nada aqui dentro do filtro selecionado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
