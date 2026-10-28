"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AtribuicaoDoLead } from "@/lib/atribuicao/visao";

/** De onde o lead veio — `GET /api/v1/leads/[id]/attribution`. */
export function useAtribuicaoDoLead(leadId: string | null) {
  return useQuery({
    queryKey: ["lead-attribution", leadId],
    enabled: !!leadId,
    // Atribuição muda raramente (um clique novo que reabre o lead): sem refetch
    // a cada foco de janela.
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: AtribuicaoDoLead }>(`/api/v1/leads/${leadId}/attribution`);
      if (res && typeof res === "object" && "data" in res) return (res as { data: AtribuicaoDoLead }).data;
      return res as unknown as AtribuicaoDoLead;
    },
  });
}
