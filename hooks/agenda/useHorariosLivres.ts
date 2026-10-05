"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { HorarioLivre } from "@/lib/agenda/tipos";

export function useHorariosLivres(eventTypeId: string | null, ownerUserId?: string | null) {
  return useQuery({
    queryKey: ["agenda", "horarios-livres", eventTypeId, ownerUserId ?? null] as const,
    queryFn: () => {
      const params = new URLSearchParams({ event_type_id: eventTypeId! });
      if (ownerUserId) params.set("owner_user_id", ownerUserId);
      return apiClient
        .get<{ data: HorarioLivre[] }>(`/api/v1/agenda/horarios-livres?${params.toString()}`)
        .then((r) => r.data);
    },
    enabled: Boolean(eventTypeId),
  });
}
