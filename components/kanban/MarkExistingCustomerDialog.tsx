"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMarkExistingCustomer } from "@/hooks/kanban/useUpdateLead";

interface MarkExistingCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

export function MarkExistingCustomerDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: MarkExistingCustomerDialogProps) {
  const mutation = useMarkExistingCustomer(pipelineId);

  const handleSubmit = async () => {
    try {
      await mutation.mutateAsync({ leadId });
      onOpenChange(false);
    } catch {
      // erro já mostrado via toast
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar como cliente já existente</DialogTitle>
          <DialogDescription>
            Este card sai do kanban — a conversa continua normal no Inbox, mas
            deixa de contar como lead novo nos relatórios. Use quando a pessoa
            já é cliente de antes (do CRM ou não), não uma venda nova.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Salvando..." : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
