"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MeetingOutcome } from "@/lib/schemas/leads";

interface RegistrarPresencaArgs {
  leadId: string;
  outcome: MeetingOutcome;
}

export function useRegistrarPresenca(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, outcome }: RegistrarPresencaArgs) =>
      apiClient.post<{ data: { registered: boolean } }>(
        `/api/v1/leads/${leadId}/meetings/outcome`,
        { outcome },
      ),
    onError: showApiError,
    onSuccess: (_data, { leadId }) => {
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
      qc.invalidateQueries({ queryKey: ["timeline", leadId] });
    },
  });
}
