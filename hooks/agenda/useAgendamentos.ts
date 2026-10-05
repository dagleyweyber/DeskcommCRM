"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { Compromisso } from "@/lib/agenda/tipos";
import type { AlterarAgendamentoInput, MarcarAgendamentoInput } from "@/lib/schemas/agenda";

export interface CompromissoDaLista extends Compromisso {
  contacts: { display_name: string | null; phone_number: string | null } | null;
}

const chave = (de: string, ate: string) => ["agenda", "agendamentos", de, ate] as const;

export function useAgendamentos(de: string, ate: string) {
  return useQuery({
    queryKey: chave(de, ate),
    queryFn: () =>
      apiClient
        .get<{ data: CompromissoDaLista[] }>(
          `/api/v1/agenda/agendamentos?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`,
        )
        .then((r) => r.data),
  });
}

export function useMarcarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MarcarAgendamentoInput) =>
      apiClient.post<{ data: Compromisso }>("/api/v1/agenda/agendamentos", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda", "agendamentos"] });
    },
  });
}

export function useAlterarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: AlterarAgendamentoInput }) =>
      apiClient.patch<{ data: Compromisso }>(`/api/v1/agenda/agendamentos/${encodeURIComponent(id)}`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda", "agendamentos"] });
    },
  });
}

export function useCancelarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision, reason }: { id: string; revision: number; reason: string }) =>
      apiClient.delete<{ data: Compromisso }>(
        `/api/v1/agenda/agendamentos/${encodeURIComponent(id)}?revision=${revision}&reason=${encodeURIComponent(reason)}`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda", "agendamentos"] });
    },
  });
}
