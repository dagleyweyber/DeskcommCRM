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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useRegistrarObjecao } from "@/hooks/leads/useRegistrarObjecao";
import { CANONICAL_OBJECTIONS, OBJECTION_LABELS, type CanonicalObjection } from "@/lib/schemas/leads";

interface ObjectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

const MAX_LEN = 500;

export function ObjectionDialog({ open, onOpenChange, leadId, pipelineId }: ObjectionDialogProps) {
  const [reasonCode, setReasonCode] = useState<CanonicalObjection | "">("");
  const [note, setNote] = useState("");
  const mutation = useRegistrarObjecao(pipelineId);

  const disabled = !reasonCode || note.length > MAX_LEN || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled || !reasonCode) return;
    try {
      await mutation.mutateAsync({
        leadId,
        reason: reasonCode,
        note: note.trim() || undefined,
      });
      setReasonCode("");
      setNote("");
      onOpenChange(false);
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar objeção</DialogTitle>
          <DialogDescription>
            O negócio continua aberto — isto só fica na linha do tempo, pra explicar por que
            ele não avançou ainda.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>Motivo</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {CANONICAL_OBJECTIONS.map((code) => (
              <label
                key={code}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="objection-reason"
                  value={code}
                  checked={reasonCode === code}
                  onChange={(e) => setReasonCode(e.target.value as CanonicalObjection)}
                />
                <span>{OBJECTION_LABELS[code]}</span>
              </label>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="objection-note">Detalhe (opcional)</Label>
            <Textarea
              id="objection-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: Achou o valor alto pra essa época do ano"
              maxLength={MAX_LEN}
              rows={3}
            />
            <div className="text-right text-[11px] text-muted-foreground tabular-nums">
              {note.length}/{MAX_LEN}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? "Salvando..." : "Registrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
