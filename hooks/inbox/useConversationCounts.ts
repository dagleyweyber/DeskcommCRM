"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ConversationCounts {
  unassigned: number;
  mine: number;
  all: number;
}

/**
 * Contagens por visão do inbox (G4-02). O endpoint usa o client RLS-scoped —
 * um agent em modo own* recebe a contagem do seu escopo, não o total da org.
 *
 * `channelSessionId` (opcional): o número selecionado no filtro do inbox. Sem ele,
 * conta a organização inteira — o mesmo que a lista mostra em "todos os números".
 */
export function useConversationCounts(orgId: string | null, channelSessionId?: string) {
  return useQuery({
    queryKey: ["conversation-counts", orgId, channelSessionId ?? null],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () =>
      apiClient
        .get<{ data: ConversationCounts }>(
          channelSessionId
            ? `/api/v1/conversations/counts?channel_session_id=${encodeURIComponent(channelSessionId)}`
            : "/api/v1/conversations/counts",
        )
        .then((r) => r.data),
  });
}
