"use client";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { HorarioDeFuncionamento, JanelaSemanal } from "@/lib/agenda/tipos";

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
/** Segunda primeiro — é como a recepção lê a semana. */
const ORDEM = [1, 2, 3, 4, 5, 6, 0];

interface EditorDeHorarioProps {
  valor: HorarioDeFuncionamento;
  onChange: (valor: HorarioDeFuncionamento) => void;
}

/**
 * Horário de funcionamento semanal: liga/desliga o dia e define abertura e
 * fechamento. Uma janela por dia — pausa de almoço ou fechamento pontual se
 * faz com BLOQUEIO, que é o que a clínica já entende ("bloquear horário").
 * Um horário salvo com mais de uma janela no dia (via API) é preservado
 * enquanto ninguém mexer naquele dia.
 */
export function EditorDeHorario({ valor, onChange }: EditorDeHorarioProps) {
  function janelaDo(dow: number): JanelaSemanal | undefined {
    return valor.windows.find((w) => w.dow === dow);
  }

  function troca(dow: number, nova: JanelaSemanal | null) {
    const outras = valor.windows.filter((w) => w.dow !== dow);
    onChange({ ...valor, windows: nova ? [...outras, nova].sort((a, b) => a.dow - b.dow) : outras });
  }

  return (
    <div className="space-y-2">
      {ORDEM.map((dow) => {
        const janela = janelaDo(dow);
        const multiplas = valor.windows.filter((w) => w.dow === dow).length > 1;
        return (
          <div key={dow} className="flex flex-wrap items-center gap-3">
            <Switch
              checked={Boolean(janela)}
              onCheckedChange={(ligado) => troca(dow, ligado ? { dow, start: "08:00", end: "18:00" } : null)}
              aria-label={`Abre ${DIAS[dow]}`}
            />
            <span className="w-20 text-sm">{DIAS[dow]}</span>
            {janela ? (
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  step={900}
                  className="w-28"
                  value={janela.start}
                  onChange={(e) => e.target.value && troca(dow, { ...janela, start: e.target.value })}
                  aria-label={`Abre às (${DIAS[dow]})`}
                />
                <span className="text-sm text-muted-foreground">às</span>
                <Input
                  type="time"
                  step={900}
                  className="w-28"
                  value={janela.end}
                  onChange={(e) => e.target.value && troca(dow, { ...janela, end: e.target.value })}
                  aria-label={`Fecha às (${DIAS[dow]})`}
                />
                {janela.end <= janela.start && <span className="text-xs text-destructive">Fechamento deve ser depois da abertura</span>}
                {multiplas && <span className="text-xs text-muted-foreground">(+ outra faixa salva)</span>}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Fechado</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Todas as janelas válidas (fim depois do início)? Usado para habilitar o "Salvar". */
export function horarioValido(h: HorarioDeFuncionamento): boolean {
  return h.windows.every((w) => w.end > w.start);
}
