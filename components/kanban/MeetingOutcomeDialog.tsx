"use client";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useRegistrarPresenca } from "@/hooks/leads/useRegistrarPresenca";
import { MEETING_OUTCOMES, MEETING_OUTCOME_LABELS, type MeetingOutcome } from "@/lib/schemas/leads";

interface MeetingOutcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

export function MeetingOutcomeDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: MeetingOutcomeDialogProps) {
  const [outcome, setOutcome] = useState<MeetingOutcome | "">("");
  const mutation = useRegistrarPresenca(pipelineId);

  const disabled = !outcome || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled || !outcome) return;
    try {
      await mutation.mutateAsync({ leadId, outcome });
      setOutcome("");
      onOpenChange(false);
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar presença</DialogTitle>
          <DialogDescription>O lead compareceu à visita/reunião agendada?</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-1.5">
          {MEETING_OUTCOMES.map((code) => (
            <label
              key={code}
              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
            >
              <input
                type="radio"
                name="meeting-outcome"
                value={code}
                checked={outcome === code}
                onChange={(e) => setOutcome(e.target.value as MeetingOutcome)}
              />
              <span>{MEETING_OUTCOME_LABELS[code]}</span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? "Salvando..." : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
