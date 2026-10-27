"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { semanasDoMes } from "@/lib/agenda/grade";
import { cn } from "@/lib/utils";

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

interface MiniCalendarioProps {
  /** "YYYY-MM-DD" selecionado. */
  valor: string;
  /** "YYYY-MM-DD" de hoje no fuso da clínica (destaque). */
  hoje: string;
  onSelecionar: (data: string) => void;
  /** Dias antes deste ficam desabilitados (ex.: marcar no passado). */
  minimo?: string;
  className?: string;
}

/**
 * Calendário de mês para escolher o dia — o da lateral da Agenda e o do
 * diálogo de agendar (pedido: "clicar em qualquer dia e fazer o agendamento",
 * referência Zandu). Datas civis "YYYY-MM-DD" do começo ao fim: nada de
 * `Date` local, que mudaria o dia num navegador fora do fuso da clínica.
 */
export function MiniCalendario({ valor, hoje, onSelecionar, minimo, className }: MiniCalendarioProps) {
  const [ano, setAno] = useState(() => Number(valor.slice(0, 4)));
  const [mes0, setMes0] = useState(() => Number(valor.slice(5, 7)) - 1);

  // Escolher um dia fora do mês exibido (ex.: "Hoje") traz o mês junto.
  useEffect(() => {
    setAno(Number(valor.slice(0, 4)));
    setMes0(Number(valor.slice(5, 7)) - 1);
  }, [valor]);

  function andaMes(delta: number) {
    const total = ano * 12 + mes0 + delta;
    setAno(Math.floor(total / 12));
    setMes0(((total % 12) + 12) % 12);
  }

  const dias = semanasDoMes(ano, mes0);
  const prefixoDoMes = `${ano}-${String(mes0 + 1).padStart(2, "0")}`;

  return (
    <div className={cn("select-none", className)}>
      <div className="mb-2 flex items-center justify-between">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Mês anterior" onClick={() => andaMes(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">
          {MESES[mes0]} {ano}
        </span>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Próximo mês" onClick={() => andaMes(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {DIAS.map((d) => (
          <span key={d} className="text-[11px] font-medium text-muted-foreground">
            {d}
          </span>
        ))}
        {dias.map((d) => {
          const doMes = d.startsWith(prefixoDoMes);
          const selecionado = d === valor;
          const ehHoje = d === hoje;
          const desabilitado = minimo !== undefined && d < minimo;
          return (
            <button
              key={d}
              type="button"
              disabled={desabilitado}
              onClick={() => onSelecionar(d)}
              aria-label={d}
              aria-pressed={selecionado}
              className={cn(
                "mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors",
                doMes ? "text-foreground" : "text-muted-foreground/50",
                !selecionado && !desabilitado && "hover:bg-accent",
                ehHoje && !selecionado && "font-semibold text-primary",
                selecionado && "bg-primary font-semibold text-primary-foreground",
                desabilitado && "cursor-not-allowed opacity-30",
              )}
            >
              {Number(d.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
