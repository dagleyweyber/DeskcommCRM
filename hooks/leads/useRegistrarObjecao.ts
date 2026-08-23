"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { CanonicalObjection } from "@/lib/schemas/leads";

interface RegistrarObjecaoArgs {
  leadId: string;
  reason: CanonicalObjection;
  note?: string;
}

export function useRegistrarObjecao(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, reason, note }: RegistrarObjecaoArgs) =>
      apiClient.post<{ data: { registered: boolean } }>(`/api/v1/leads/${leadId}/objections`, {
        reason,
        note,
      }),
    onError: showApiError,
    onSuccess: (_data, { leadId }) => {
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
      qc.invalidateQueries({ queryKey: ["timeline", leadId] });
    },
  });
}
