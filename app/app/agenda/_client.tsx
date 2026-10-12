"use client";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { GradeDoDia } from "@/components/agenda/GradeDoDia";
import { MarcarCompromissoDialog } from "@/components/agenda/MarcarCompromissoDialog";
import { useAgendamentos } from "@/hooks/agenda/useAgendamentos";
import { useAttendants } from "@/hooks/team/useAttendants";

/** 00:00 local do dia que contém `d`. */
function inicioDoDia(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function AgendaClient() {
  const [dia, setDia] = useState(() => inicioDoDia(new Date()));

  const { de, ate } = useMemo(() => {
    const fim = new Date(dia);
    fim.setDate(fim.getDate() + 1);
    return { de: dia.toISOString(), ate: fim.toISOString() };
  }, [dia]);

  const { data: compromissos, isLoading, refetch } = useAgendamentos(de, ate);
  const { data: atendentes, isLoading: carregandoAtendentes } = useAttendants();

  function mudaDia(delta: number) {
    const proximo = new Date(dia);
    proximo.setDate(proximo.getDate() + delta);
    setDia(inicioDoDia(proximo));
  }

  const carregando = isLoading || carregandoAtendentes;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mudaDia(-1)}>
            ← Dia anterior
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDia(inicioDoDia(new Date()))}>
            Hoje
          </Button>
          <span className="text-sm font-medium capitalize">
            {dia.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
          </span>
          <Button variant="outline" size="sm" onClick={() => mudaDia(1)}>
            Dia seguinte →
          </Button>
        </div>
        <MarcarCompromissoDialog onMarcado={() => void refetch()} />
      </div>

      {carregando ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <GradeDoDia compromissos={compromissos ?? []} atendentes={atendentes?.data ?? []} />
      )}
    </div>
  );
}
