"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ResumoDeCliques } from "@/lib/atribuicao/resumo-de-cliques";

/** Cliques no botão do WhatsApp × conversas ligadas — `GET /api/v1/rastreio/cliques/resumo`. */
export function useResumoDeCliques(enabled = true) {
  return useQuery({
    queryKey: ["rastreio-cliques-resumo"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: ResumoDeCliques }>("/api/v1/rastreio/cliques/resumo");
      if (res && typeof res === "object" && "data" in res) return (res as { data: ResumoDeCliques }).data;
      return res as unknown as ResumoDeCliques;
    },
  });
}
