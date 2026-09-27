"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { EdicaoDaTarefa, NovaTarefa, Tarefa } from "@/lib/tarefas/tipos";

/**
 * As tarefas da organização, com as três mutações que a tela dispara.
 *
 * Sem `refetchInterval`: recarregar a lista inteira a cada N segundos custa
 * uma consulta por aba aberta o dia inteiro para dado que só muda quando
 * alguém desta mesma aba mexe. As mutações já invalidam a chave — o que
 * faltava era a volta ao foco, que cobre o caso real de duas pessoas do time
 * editando ao mesmo tempo.
 */
const BASE = "/api/v1/tasks";
const CHAVE = ["crm_tasks"] as const;

export interface FiltrosDeTarefa {
  status?: string;
  priority?: string;
  lead_id?: string;
  contact_id?: string;
  /** `true` = só o que ainda pede ação (pendente ou em andamento). */
  aberto?: boolean;
}

interface TarefasResponse {
  data: { tasks: Tarefa[] };
}
interface TarefaResponse {
  data: { task: Tarefa };
}

export function useTasks(filtros: FiltrosDeTarefa = {}) {
  const queryClient = useQueryClient();

  const params = new URLSearchParams();
  if (filtros.status) params.set("status", filtros.status);
  if (filtros.priority) params.set("priority", filtros.priority);
  if (filtros.lead_id) params.set("lead_id", filtros.lead_id);
  if (filtros.contact_id) params.set("contact_id", filtros.contact_id);
  if (filtros.aberto) params.set("aberto", "true");
  const qs = params.toString();

  const query = useQuery({
    queryKey: [...CHAVE, qs] as const,
    queryFn: () => apiClient.get<TarefasResponse>(qs ? `${BASE}?${qs}` : BASE),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const invalidar = () => queryClient.invalidateQueries({ queryKey: CHAVE });

  const criar = useMutation({
    mutationFn: (entrada: NovaTarefa) => apiClient.post<TarefaResponse>(BASE, entrada),
    onSuccess: invalidar,
  });

  const editar = useMutation({
    mutationFn: ({ id, entrada }: { id: string; entrada: EdicaoDaTarefa }) =>
      apiClient.patch<TarefaResponse>(`${BASE}/${id}`, entrada),
    onSuccess: invalidar,
  });

  const apagar = useMutation({
    mutationFn: (id: string) => apiClient.delete<{ data: { deleted: boolean } }>(`${BASE}/${id}`),
    onSuccess: invalidar,
  });

  return {
    tarefas: query.data?.data.tasks ?? [],
    carregando: query.isLoading,
    falhou: query.isError,
    recarregar: invalidar,
    criarTarefa: async (entrada: NovaTarefa) => (await criar.mutateAsync(entrada)).data.task,
    editarTarefa: async (id: string, entrada: EdicaoDaTarefa) =>
      (await editar.mutateAsync({ id, entrada })).data.task,
    apagarTarefa: (id: string) => apagar.mutateAsync(id),
    alternarConcluida: (tarefa: Tarefa) =>
      editar.mutateAsync({
        id: tarefa.id,
        entrada: { status: tarefa.status === "done" ? "pending" : "done" },
      }),
  };
}
