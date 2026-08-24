"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface AgendarVisitaArgs {
  leadId: string;
  scheduledAt: string;
}

export function useAgendarVisita(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, scheduledAt }: AgendarVisitaArgs) =>
      apiClient.post<{ data: { registered: boolean } }>(
        `/api/v1/leads/${leadId}/meetings/schedule`,
        { scheduled_at: scheduledAt },
      ),
    onError: showApiError,
    onSuccess: (_data, { leadId }) => {
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
      qc.invalidateQueries({ queryKey: ["timeline", leadId] });
    },
  });
}
