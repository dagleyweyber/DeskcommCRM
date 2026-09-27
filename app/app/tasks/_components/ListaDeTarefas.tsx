"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  agrupaPorPrazo,
  estaAtrasada,
  estaEncerrada,
  type FaixaDePrazo,
  type PrioridadeDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";
import { Check, PencilSimple, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  tarefas: Tarefa[];
  podeEditar: boolean;
  aoAlternarConcluida: (tarefa: Tarefa) => Promise<unknown>;
  aoEditar: (tarefa: Tarefa) => void;
  aoApagar: (tarefa: Tarefa) => Promise<unknown>;
}

/** A cor é do TEMA, nunca um hex: ela tem de sobreviver ao claro e ao escuro. */
const COR_DA_PRIORIDADE: Record<PrioridadeDaTarefa, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-primary/10 text-primary",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-destructive/15 text-destructive",
};

const ROTULO_DA_PRIORIDADE: Record<PrioridadeDaTarefa, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  urgent: "Urgente",
};

function Linha({
  tarefa,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
}: {
  tarefa: Tarefa;
  podeEditar: boolean;
  aoAlternarConcluida: (t: Tarefa) => Promise<unknown>;
  aoEditar: (t: Tarefa) => void;
  aoApagar: (t: Tarefa) => Promise<unknown>;
}) {
  const [ocupada, setOcupada] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const encerrada = estaEncerrada(tarefa);
  const atrasada = estaAtrasada(tarefa);

  async function comBloqueio(acao: () => Promise<unknown>) {
    setOcupada(true);
    try {
      await acao();
    } finally {
      setOcupada(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40",
        encerrada && "opacity-60",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={encerrada}
        aria-label={encerrada ? "Reabrir a tarefa" : "Marcar como concluída"}
        disabled={ocupada || !podeEditar}
        onClick={() => comBloqueio(() => aoAlternarConcluida(tarefa))}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors",
          encerrada
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
      >
        {encerrada ? <Check size={12} weight="bold" aria-hidden /> : null}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            encerrada && "text-muted-foreground line-through",
          )}
        >
          {tarefa.title}
        </p>
        {tarefa.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{tarefa.description}</p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-medium",
              COR_DA_PRIORIDADE[tarefa.priority],
            )}
          >
            {ROTULO_DA_PRIORIDADE[tarefa.priority]}
          </span>
          <span className={cn("text-muted-foreground", atrasada && "font-semibold text-destructive")}>
            {tarefa.due_date
              ? new Date(tarefa.due_date).toLocaleString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Sem prazo"}
          </span>
        </div>
      </div>

      {podeEditar ? (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Editar a tarefa"
            onClick={() => aoEditar(tarefa)}
          >
            <PencilSimple size={14} aria-hidden />
          </Button>
          {/*
            Confirmação em DOIS TOQUES no lugar de `confirm()`: `window.confirm`
            é bloqueado em iframe e ignora o tema.
          */}
          {confirmando ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={ocupada}
              onClick={() => comBloqueio(() => aoApagar(tarefa))}
            >
              Confirmar
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Apagar a tarefa"
              onClick={() => setConfirmando(true)}
              onBlur={() => setConfirmando(false)}
            >
              <Trash size={14} aria-hidden />
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

const ROTULO_DA_FAIXA: Record<FaixaDePrazo, string> = {
  atrasada: "Atrasadas",
  hoje: "Hoje",
  esta_semana: "Esta semana",
  mais_tarde: "Mais tarde",
  sem_prazo: "Sem prazo",
  encerrada: "Encerradas",
};

export function ListaDeTarefas({
  tarefas,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
}: Props) {
  const grupos = agrupaPorPrazo(tarefas);

  if (grupos.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-sm font-medium">Nenhuma tarefa por aqui</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enquanto isto estiver vazio, o que foi combinado vive só na memória
          de alguém.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grupos.map((grupo) => (
        <section key={grupo.faixa}>
          <h2
            className={cn(
              "mb-1 px-3 text-xs font-semibold uppercase tracking-wider",
              grupo.faixa === "atrasada" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {ROTULO_DA_FAIXA[grupo.faixa]}
          </h2>
          <div className="rounded-xl border bg-card py-1">
            {grupo.tarefas.map((tarefa) => (
              <Linha
                key={tarefa.id}
                tarefa={tarefa}
                podeEditar={podeEditar}
                aoAlternarConcluida={aoAlternarConcluida}
                aoEditar={aoEditar}
                aoApagar={aoApagar}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
