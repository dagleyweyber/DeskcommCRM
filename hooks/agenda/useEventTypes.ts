"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CreateEventTypeInput, UpdateEventTypeInput } from "@/lib/schemas/agenda";
import type { TipoDeCompromisso } from "@/lib/agenda/tipos";

const CHAVE = ["agenda", "tipos"] as const;

export function useEventTypes(opcoes: { incluirInativos?: boolean } = {}) {
  return useQuery({
    queryKey: [...CHAVE, opcoes.incluirInativos ?? false] as const,
    queryFn: () =>
      apiClient
        .get<{ data: TipoDeCompromisso[] }>(`/api/v1/agenda/tipos${opcoes.incluirInativos ? "?incluir_inativos=true" : ""}`)
        .then((r) => r.data),
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

export function useAtualizarTipoDeCompromisso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateEventTypeInput }) =>
      apiClient.patch<{ data: TipoDeCompromisso }>(`/api/v1/agenda/tipos/${encodeURIComponent(id)}`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      void qc.invalidateQueries({ queryKey: ["agenda", "horarios-livres"] });
    },
  });
}
