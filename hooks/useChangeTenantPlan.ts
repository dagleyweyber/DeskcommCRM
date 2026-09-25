"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import type { TenantPlan } from "@/lib/schemas/tenant-plan";

export interface ChangeTenantPlanPayload {
  id: string;
  plan: TenantPlan;
}

export function useChangeTenantPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, plan }: ChangeTenantPlanPayload) =>
      apiClient.post(`/api/v1/admin/tenants/${id}/plan`, { plan }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      toast.success("Plano do tenant atualizado");
    },
    onError: (err: Error) => {
      toast.error("Erro ao trocar o plano", { description: err.message });
    },
  });
}
