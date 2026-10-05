"use client";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ListaDeCompromissos } from "@/components/agenda/ListaDeCompromissos";
import { MarcarCompromissoDialog } from "@/components/agenda/MarcarCompromissoDialog";
import { useAgendamentos } from "@/hooks/agenda/useAgendamentos";

/** Domingo da semana que contém `d`, 00:00 local. */
function inicioDaSemana(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

export function AgendaClient() {
  const [semanaBase, setSemanaBase] = useState(() => inicioDaSemana(new Date()));

  const { de, ate } = useMemo(() => {
    const fim = new Date(semanaBase);
    fim.setDate(fim.getDate() + 7);
    return { de: semanaBase.toISOString(), ate: fim.toISOString() };
  }, [semanaBase]);

  const { data: compromissos, isLoading, refetch } = useAgendamentos(de, ate);

  function mudaSemana(delta: number) {
    const proxima = new Date(semanaBase);
    proxima.setDate(proxima.getDate() + delta * 7);
    setSemanaBase(proxima);
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mudaSemana(-1)}>
            ← Semana anterior
          </Button>
          <span className="text-sm font-medium">
            {semanaBase.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })} —{" "}
            {new Date(new Date(semanaBase).setDate(semanaBase.getDate() + 6)).toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "short",
            })}
          </span>
          <Button variant="outline" size="sm" onClick={() => mudaSemana(1)}>
            Semana seguinte →
          </Button>
        </div>
        <MarcarCompromissoDialog onMarcado={() => void refetch()} />
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <ListaDeCompromissos compromissos={compromissos ?? []} />
      )}
    </div>
  );
}
