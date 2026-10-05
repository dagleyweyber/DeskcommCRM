"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useCancelarAgendamento, type CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import type { StatusDoCompromisso } from "@/lib/agenda/tipos";

const RÓTULO_DO_STATUS: Record<StatusDoCompromisso, string> = {
  pending: "Pendente",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  completed: "Compareceu",
  no_show: "Não compareceu",
};

const COR_DO_STATUS: Record<StatusDoCompromisso, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  confirmed: "default",
  cancelled: "destructive",
  completed: "secondary",
  no_show: "destructive",
};

function agrupaPorDia(compromissos: CompromissoDaLista[]): Map<string, CompromissoDaLista[]> {
  const grupos = new Map<string, CompromissoDaLista[]>();
  for (const c of compromissos) {
    const dia = new Date(c.starts_at).toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
    });
    const lista = grupos.get(dia) ?? [];
    lista.push(c);
    grupos.set(dia, lista);
  }
  return grupos;
}

export function ListaDeCompromissos({ compromissos }: { compromissos: CompromissoDaLista[] }) {
  const cancelar = useCancelarAgendamento();
  const [alvoDoCancelamento, setAlvoDoCancelamento] = useState<CompromissoDaLista | null>(null);

  if (compromissos.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nenhum compromisso neste período.</p>;
  }

  const grupos = agrupaPorDia(compromissos);

  async function confirmarCancelamento() {
    if (!alvoDoCancelamento) return;
    try {
      await cancelar.mutateAsync({
        id: alvoDoCancelamento.id,
        revision: alvoDoCancelamento.revision,
        reason: "Cancelado pela Agenda",
      });
      toast.success("Compromisso cancelado.");
      setAlvoDoCancelamento(null);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="space-y-6">
      {Array.from(grupos.entries()).map(([dia, itens]) => (
        <div key={dia}>
          <h3 className="mb-2 text-sm font-medium capitalize text-muted-foreground">{dia}</h3>
          <ul className="space-y-2">
            {itens.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-sm font-medium tabular-nums">
                    {new Date(c.starts_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{c.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.contacts?.display_name ?? c.contacts?.phone_number ?? "Sem contato"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={COR_DO_STATUS[c.status]}>{RÓTULO_DO_STATUS[c.status]}</Badge>
                  {c.status !== "cancelled" && c.status !== "completed" && c.status !== "no_show" && (
                    <Button variant="ghost" size="sm" onClick={() => setAlvoDoCancelamento(c)}>
                      Cancelar
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <AlertDialog open={alvoDoCancelamento !== null} onOpenChange={(v) => !v && setAlvoDoCancelamento(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar compromisso?</AlertDialogTitle>
            <AlertDialogDescription>
              O horário volta a ficar disponível imediatamente. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmarCancelamento()}>Cancelar compromisso</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
