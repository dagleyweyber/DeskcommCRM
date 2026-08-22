"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface PipelineListItem {
  id: string;
  name: string;
}

/** GET /api/v1/pipelines é manager+ (spec de settings) — gateie `enabled` do mesmo jeito que useTeamMembers. */
export function usePipelinesList(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pipelines", "list"],
    queryFn: async () => apiClient.get<{ data: PipelineListItem[] }>("/api/v1/pipelines"),
    staleTime: 30_000,
    enabled: opts?.enabled ?? true,
  });
}
