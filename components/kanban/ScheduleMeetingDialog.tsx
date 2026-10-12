"use client";
import { useQueryClient } from "@tanstack/react-query";

import { MarcarCompromissoDialog } from "@/components/agenda/MarcarCompromissoDialog";

interface ScheduleMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
  /** `contact_id` do lead — chamador garante que existe (ver guard em KanbanCardActions). */
  contactId: string;
  /** `lead.title` já serve de nome de exibição — mesmo valor mostrado no card. */
  contactLabel: string;
}

/**
 * Agendar direto do negócio PRECISA criar um `calendar_appointments` de
 * verdade — não um registro solto na timeline (era o que a versão antiga
 * desta tela fazia, chamando `/leads/[id]/meetings/schedule`). Virou um
 * wrapper fino sobre `MarcarCompromissoDialog` (contato travado no do lead)
 * em vez de reimplementar o fluxo: a Agenda já emite o `meeting_scheduled` na
 * timeline do negócio sozinha (`fecharOLaco`, em `agenda/_handler.ts`) assim
 * que o compromisso é criado — repetir essa emissão aqui duplicaria a regra
 * em dois lugares que podem divergir.
 */
export function ScheduleMeetingDialog({
  open,
  onOpenChange,
  pipelineId,
  contactId,
  contactLabel,
}: ScheduleMeetingDialogProps) {
  const qc = useQueryClient();
  return (
    <MarcarCompromissoDialog
      open={open}
      onOpenChange={onOpenChange}
      contatoFixo={{ id: contactId, display_name: contactLabel, phone_number: null }}
      // `fecharOLaco` já grava o `meeting_scheduled` na timeline do negócio —
      // só falta o board (que lê isso via `withNextMeetings`) saber que mudou.
      onMarcado={() => void qc.invalidateQueries({ queryKey: ["board", pipelineId] })}
    />
  );
}
