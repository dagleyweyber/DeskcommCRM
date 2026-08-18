"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Lead } from "@/lib/types/leads";
import { LeadFieldsForm } from "./LeadFieldsForm";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
}

/**
 * Wrapper fino sobre `LeadFieldsForm` — o MESMO form do dossiê ("Editar
 * campos"), não uma cópia. Chegou a ser cópia (título, descrição, valor, tags,
 * fechamento previsto) e divergiu na hora em que o dossiê ganhou origem,
 * produto de interesse, e-mail e telefone: quem editasse por aqui via menos
 * campos do que por lá, sem nenhum motivo — as duas entradas editam o mesmo
 * lead. `key={lead.id}` força remontagem ao trocar de lead OU reabrir o
 * diálogo, descartando edição não salva — o mesmo comportamento que o reset
 * em `[open, lead.id]` daqui garantia antes.
 */
export function EditLeadDialog({ open, onOpenChange, lead, pipelineId }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar lead</DialogTitle>
          <DialogDescription>
            Atualize os campos. Mover de etapa ou marcar ganho/perdido tem opções
            próprias.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <LeadFieldsForm
            key={lead.id}
            lead={lead}
            pipelineId={pipelineId}
            onSaved={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
