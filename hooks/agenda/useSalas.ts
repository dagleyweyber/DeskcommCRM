"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { HorarioDeFuncionamento, Sala } from "@/lib/agenda/tipos";
import type { CreateBloqueioInput, CreateSalaInput, UpdateSalaInput } from "@/lib/schemas/agenda";

const CHAVE = ["agenda", "salas"] as const;

export interface SalasDaClinica {
  salas: Sala[];
  horario_padrao: HorarioDeFuncionamento;
}

export function useSalas(opcoes: { incluirInativas?: boolean } = {}) {
  return useQuery({
    queryKey: [...CHAVE, opcoes.incluirInativas ?? false] as const,
    queryFn: () =>
      apiClient
        .get<{ data: SalasDaClinica }>(`/api/v1/agenda/salas${opcoes.incluirInativas ? "?incluir_inativas=true" : ""}`)
        .then((r) => r.data),
  });
}

export function useCriarSala() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSalaInput) => apiClient.post<{ data: Sala }>("/api/v1/agenda/salas", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useAtualizarSala() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSalaInput }) =>
      apiClient.patch<{ data: Sala }>(`/api/v1/agenda/salas/${encodeURIComponent(id)}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useSalvarHorarioPadrao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (defaultSchedule: HorarioDeFuncionamento) =>
      apiClient.put<{ data: { default_schedule: HorarioDeFuncionamento } }>("/api/v1/agenda/configuracao", {
        default_schedule: defaultSchedule,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export interface Bloqueio {
  id: string;
  room_id: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

const CHAVE_BLOQUEIOS = ["agenda", "bloqueios"] as const;

export function useBloqueios(de: string, ate: string) {
  return useQuery({
    queryKey: [...CHAVE_BLOQUEIOS, de, ate] as const,
    queryFn: () =>
      apiClient
        .get<{ data: Bloqueio[] }>(`/api/v1/agenda/bloqueios?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`)
        .then((r) => r.data),
  });
}

export function useCriarBloqueio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBloqueioInput) => apiClient.post<{ data: Bloqueio }>("/api/v1/agenda/bloqueios", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE_BLOQUEIOS });
      void qc.invalidateQueries({ queryKey: ["agenda", "horarios-livres"] });
    },
  });
}

export function useRemoverBloqueio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<{ data: { id: string } }>(`/api/v1/agenda/bloqueios/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE_BLOQUEIOS });
      void qc.invalidateQueries({ queryKey: ["agenda", "horarios-livres"] });
    },
  });
}
