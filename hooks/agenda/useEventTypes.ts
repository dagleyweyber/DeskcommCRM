"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CreateEventTypeInput } from "@/lib/schemas/agenda";
import type { TipoDeCompromisso } from "@/lib/agenda/tipos";

const CHAVE = ["agenda", "tipos"] as const;

export function useEventTypes() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: () => apiClient.get<{ data: TipoDeCompromisso[] }>("/api/v1/agenda/tipos").then((r) => r.data),
  });
}

export function useCriarTipoDeCompromisso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventTypeInput) =>
      apiClient.post<{ data: TipoDeCompromisso }>("/api/v1/agenda/tipos", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}
