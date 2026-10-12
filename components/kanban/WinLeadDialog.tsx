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
import { useWinLead } from "@/hooks/kanban/useUpdateLead";
import { parseReaisToCents, formatCentsBRL } from "@/lib/money";

interface WinLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

export function WinLeadDialog({ open, onOpenChange, leadId, pipelineId }: WinLeadDialogProps) {
  const [valueReais, setValueReais] = useState("");
  const mutation = useWinLead(pipelineId);

  const valueCents = parseReaisToCents(valueReais);
  const disabled = valueCents === null || valueCents <= 0 || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled || valueCents === null) return;
    try {
      await mutation.mutateAsync({ leadId, valueCents });
      setValueReais("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar como ganho</DialogTitle>
          <DialogDescription>Informe o valor da venda.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="win-value">Valor (R$)</Label>
          <Input
            id="win-value"
            inputMode="decimal"
            placeholder="0,00"
            autoFocus
            value={valueReais}
            onChange={(e) => setValueReais(e.target.value)}
          />
          {valueCents !== null && valueCents > 0 && (
            <p className="text-xs text-muted-foreground">= {formatCentsBRL(valueCents)}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
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
