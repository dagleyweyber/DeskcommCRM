"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { HorarioLivre } from "@/lib/agenda/tipos";

export interface FiltroDosHorarios {
  /** Sala fixa; ausente = qualquer sala permitida para o serviço. */
  roomId?: string | null;
  /** "YYYY-MM-DD" — o dia escolhido no calendário. */
  data?: string | null;
  /** Compromisso em edição — não conta como ocupado contra ele mesmo. */
  ignorarId?: string | null;
}

export function useHorariosLivres(eventTypeId: string | null, filtro: FiltroDosHorarios = {}) {
  return useQuery({
    queryKey: ["agenda", "horarios-livres", eventTypeId, filtro.roomId ?? null, filtro.data ?? null, filtro.ignorarId ?? null] as const,
    queryFn: () => {
      const params = new URLSearchParams({ event_type_id: eventTypeId! });
      if (filtro.roomId) params.set("room_id", filtro.roomId);
      if (filtro.data) params.set("data", filtro.data);
      if (filtro.ignorarId) params.set("ignorar_id", filtro.ignorarId);
      return apiClient
        .get<{ data: HorarioLivre[] }>(`/api/v1/agenda/horarios-livres?${params.toString()}`)
        .then((r) => r.data);
    },
    enabled: Boolean(eventTypeId),
  });
}
