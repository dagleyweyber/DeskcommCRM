"use client";
/**
 * RunsTable — tabela de execuções com Realtime (S-13.12).
 *
 * Mostra a página mais recente (limit 25). Click numa row → drawer com trace.
 *
 * ⚠️ Só cobre agentes que passam pelo motor via `ai_agent_runs`
 * (lib/ai/runtime/agent.ts). Achado ao vivo (RevitaFio Mossoro, agente
 * "Mariana"): o OUTRO motor de produção (lib/agent-engine/agent/
 * inbound-turn.ts, processo `workers/agent-worker/main.ts`) nunca escreve
 * nessa tabela — ele registra em `llm_calls`, que é o que alimenta a tela
 * geral "Agente de IA › Execuções" (`/app/ai/runs`). Um agente real,
 * respondendo cliente, pode legitimamente mostrar "nenhuma execução" AQUI
 * — daí o aviso no estado vazio abaixo apontar pra lá, em vez de deixar
 * a pessoa concluir que o agente está parado.
 */
import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useAgentRuns, type AgentRunRow } from "@/hooks/ai/useAgentRuns";
import { RunDetailDrawer } from "./RunDetailDrawer";

interface Props {
  agentId: string;
  active: boolean;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "secondary",
  completed: "default",
  failed: "destructive",
  aborted: "destructive",
  timeout: "destructive",
};

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(cents: number | null): string {
  if (cents == null) return "—";
  return `US$ ${(cents / 100).toFixed(4)}`;
}

export function RunsTable({ agentId, active }: Props) {
  const { data, isLoading, error, refetch, isFetching } = useAgentRuns(agentId, {
    enabled: active,
    realtime: active,
  });
  const [selected, setSelected] = React.useState<AgentRunRow | null>(null);
  const [open, setOpen] = React.useState(false);

  const rows = data?.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? "Carregando…" : `${rows.length} execuções recentes`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Atualizando…" : "Atualizar"}
        </Button>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Erro ao carregar execuções.
        </p>
      ) : null}

      <div className="rounded-md border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[170px]">Início</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Tokens (in/out)</TableHead>
              <TableHead>Custo</TableHead>
              <TableHead>Latência</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="p-4 text-center text-sm text-muted-foreground">
                  <p>Nenhuma execução aqui ainda.</p>
                  <p className="mt-1 text-xs">
                    Se este agente já está respondendo cliente de verdade e não aparece
                    nada acima, confira{" "}
                    <Link href="/app/ai/runs" className="underline underline-offset-2">
                      Agente de IA › Execuções (visão geral)
                    </Link>{" "}
                    — alguns agentes registram lá, não aqui.
                  </p>
                </TableCell>
              </TableRow>
            ) : null}

            {rows.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => {
                  setSelected(r);
                  setOpen(true);
                }}
              >
                <TableCell className="font-mono text-xs">
                  {new Date(r.started_at).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[r.status] ?? "outline"} className="text-xs">
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {r.is_dry_run ? (
                    <Badge variant="outline" className="text-xs">
                      teste
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">produção</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {(r.tokens_in ?? 0).toLocaleString()} /{" "}
                  {(r.tokens_out ?? 0).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">{fmtCost(r.cost_cents)}</TableCell>
                <TableCell className="font-mono text-xs">{fmtLatency(r.latency_ms)}</TableCell>
                <TableCell className="font-mono text-xs">{r.steps_count ?? 0}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(r);
                      setOpen(true);
                    }}
                  >
                    Detalhes
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RunDetailDrawer run={selected} open={open} onOpenChange={setOpen} />
    </div>
  );
}
