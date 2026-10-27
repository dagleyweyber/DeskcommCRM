import { Calendar } from "@/lib/ui/icons";
import { RÓTULO_DO_STATUS } from "@/lib/agenda/tipos";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";

/** Mesmas cores da grade da Agenda (`components/agenda/status.ts`), em tom de texto. */
const COR_DO_STATUS: Partial<Record<NonNullable<Lead["next_meeting_status"]>, string>> = {
  pending: "text-sky-600 dark:text-sky-400",
  confirmed: "text-emerald-600 dark:text-emerald-400",
  declined: "text-red-600 dark:text-red-400",
};

/**
 * Data/hora + status do próximo compromisso da AGENDA do contato — pedido
 * explícito do usuário: ver isso sem precisar abrir o card. Vem da mesma
 * tabela que a grade da Agenda (`withNextMeetings` no board route): marcou,
 * remarcou, cancelou ou o cliente confirmou pelo WhatsApp — aparece aqui.
 * Some por inteiro quando não há compromisso em aberto.
 */
export function NextMeetingSlot({
  nextMeetingAt,
  status,
}: {
  nextMeetingAt: Lead["next_meeting_at"];
  status?: Lead["next_meeting_status"];
}) {
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
      title="Compromisso na Agenda"
    >
      <Calendar size={12} weight="regular" className="shrink-0" aria-hidden />
      <span className="truncate">{texto}</span>
      {status && (
        <span className={cn("shrink-0 font-medium", COR_DO_STATUS[status])}>· {RÓTULO_DO_STATUS[status]}</span>
      )}
    </div>
  );
}
