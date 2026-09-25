"use client";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChangeTenantPlan } from "@/hooks/useChangeTenantPlan";
import { TENANT_PLANS, TENANT_PLAN_LABEL, type TenantPlan } from "@/lib/schemas/tenant-plan";

interface ChangePlanDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  currentPlan: TenantPlan | null;
}

export function ChangePlanDialog({
  open,
  onClose,
  organizationId,
  currentPlan,
}: ChangePlanDialogProps) {
  const [plan, setPlan] = useState<TenantPlan>(currentPlan ?? "standard");

  const changePlan = useChangeTenantPlan();

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setPlan(currentPlan ?? "standard");
      onClose();
    }
  }

  function handleConfirm() {
    changePlan.mutate(
      { id: organizationId, plan },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Trocar plano</AlertDialogTitle>
          <AlertDialogDescription>
            Muda o plano contratado deste tenant. Não afeta funcionalidades já liberadas na
            plataforma — é só o registro comercial.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="change-plan-select">Novo plano</Label>
          <Select value={plan} onValueChange={(v) => setPlan(v as TenantPlan)}>
            <SelectTrigger id="change-plan-select" aria-label="Novo plano">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TENANT_PLANS.map((p) => (
                <SelectItem key={p} value={p}>
                  {TENANT_PLAN_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => handleOpenChange(false)}>Cancelar</AlertDialogCancel>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={plan === currentPlan || changePlan.isPending}
          >
            {changePlan.isPending ? "Salvando..." : "Confirmar troca"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
