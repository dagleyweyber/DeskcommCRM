import { Calendar } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";

/**
 * Data/hora da visita/reunião agendada — pedido explícito do usuário: ver
 * isso sem precisar abrir o card. Mesmo padrão de `ConversaSlot`: LEFT, some
 * por inteiro quando não há agendamento pendente (a maioria dos leads nunca
 * agendou, ou já teve presença/ausência registrada — ver `withNextMeetings`
 * no board route).
 */
export function NextMeetingSlot({ nextMeetingAt }: { nextMeetingAt: Lead["next_meeting_at"] }) {
  if (!nextMeetingAt) return null;

  const texto = new Date(nextMeetingAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className="mt-1 flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-text-muted"
      title="Visita/reunião agendada"
    >
      <Calendar size={12} weight="regular" className="shrink-0" aria-hidden />
      <span className="truncate">{texto}</span>
    </div>
  );
}
