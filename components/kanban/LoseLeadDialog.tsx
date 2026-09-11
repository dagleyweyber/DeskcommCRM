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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLoseLead } from "@/hooks/kanban/useUpdateLead";
import { formatLostReason, motivosParaExibir } from "@/lib/schemas/leads";

interface LoseLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
  /** Extensão curada do pipeline (`settings.lost_reasons`) — ver `motivosParaExibir`. */
  extraReasons?: string[];
}

const MAX_LEN = 500;

export function LoseLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
  extraReasons,
}: LoseLeadDialogProps) {
  const [reasonCode, setReasonCode] = useState<string>("");
  const [otherText, setOtherText] = useState("");
  const mutation = useLoseLead(pipelineId);
  const motivos = motivosParaExibir(extraReasons ?? []);

  const finalReason = reasonCode === "other" ? otherText.trim() || "other" : reasonCode;
  const disabled = !reasonCode || finalReason.length === 0 || finalReason.length > MAX_LEN || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, lostReason: finalReason });
      setReasonCode("");
      setOtherText("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar como perdido</DialogTitle>
          <DialogDescription>
            Informe o motivo. Essa informação ajuda a melhorar o funil.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label htmlFor="lost-reason">Motivo</Label>
          <Select value={reasonCode} onValueChange={setReasonCode}>
            <SelectTrigger id="lost-reason">
              <SelectValue placeholder="Selecione o motivo" />
            </SelectTrigger>
            <SelectContent>
              {motivos.map((code) => (
                <SelectItem key={code} value={code}>
                  {formatLostReason(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {reasonCode === "other" && (
            <div className="grid gap-1.5">
              <Label htmlFor="lost-reason-other">Detalhe (opcional)</Label>
              <Textarea
                id="lost-reason-other"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="Ex: Cliente desistiu por X motivo"
                maxLength={MAX_LEN}
                rows={3}
              />
              <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                {otherText.length}/{MAX_LEN}
              </div>
            </div>
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
