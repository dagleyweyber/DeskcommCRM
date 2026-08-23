"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Lista de serviços/produtos do funil (Configurações › Funis). Vazia ⇒ campo continua texto livre. */
export function useServiceOptions(pipelineId: string) {
  return useQuery({
    queryKey: ["pipelines", pipelineId, "service-options"],
    queryFn: async () =>
      apiClient.get<{ data: { service_options: string[] } }>(
        `/api/v1/pipelines/${pipelineId}/service-options`,
      ),
    staleTime: 60_000,
    enabled: !!pipelineId,
  });
}
