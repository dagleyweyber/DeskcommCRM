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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgendarVisita } from "@/hooks/leads/useAgendarVisita";

interface ScheduleMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

/** "2026-08-25T14:30" (datetime-local, sem timezone) → ISO com offset local. */
function toIsoWithOffset(localValue: string): string {
  const d = new Date(localValue);
  return d.toISOString();
}

export function ScheduleMeetingDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: ScheduleMeetingDialogProps) {
  const [value, setValue] = useState("");
  const mutation = useAgendarVisita(pipelineId);

  const disabled = !value || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, scheduledAt: toIsoWithOffset(value) });
      setValue("");
      onOpenChange(false);
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agendar visita/reunião</DialogTitle>
          <DialogDescription>
            Reagendar é agendar de novo — a data anterior fica no histórico do negócio.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="meeting-scheduled-at">Data e hora</Label>
          <Input
            id="meeting-scheduled-at"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? "Salvando..." : "Agendar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
