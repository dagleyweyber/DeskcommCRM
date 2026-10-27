"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import type { Compromisso } from "@/lib/agenda/tipos";
import type { AlterarAgendamentoInput, MarcarAgendamentoInput } from "@/lib/schemas/agenda";

export interface CompromissoDaLista extends Compromisso {
  contacts: { display_name: string | null; phone_number: string | null } | null;
  calendar_event_types: { name: string; duration_minutes: number } | null;
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
    refetchInterval: 60_000,
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

/**
 * Grade ao vivo: qualquer mudança em `calendar_appointments` da organização
 * (outra aba, outra recepcionista, a IA marcando, o cliente confirmando pela
 * automação) recarrega a lista. `refetchInterval` de 60s em `useAgendamentos`
 * é a rede de segurança se o canal parar de entregar em silêncio.
 */
export function useAgendaAoVivo(orgId: string | null | undefined) {
  const qc = useQueryClient();
  return useRealtimeChannel({
    name: orgId ? `agenda-${orgId}` : "agenda-disabled",
    postgresChanges: orgId
      ? { event: "*", schema: "public", table: "calendar_appointments", filter: `organization_id=eq.${orgId}` }
      : undefined,
    onChange: () => {
      void qc.invalidateQueries({ queryKey: ["agenda", "agendamentos"] });
      void qc.invalidateQueries({ queryKey: ["agenda", "horarios-livres"] });
    },
    enabled: Boolean(orgId),
  });
}
