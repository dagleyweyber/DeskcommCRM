"use client";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface ListPage {
  data: ConversationWithContact[];
}

/**
 * Zera as não lidas da conversa aberta. A bolinha some na hora (otimista) — o
 * Realtime confirma em seguida. Falha é silenciosa de propósito: a conversa
 * abriu, que é o que o atendente pediu; na próxima abertura tenta de novo.
 */
export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) =>
      apiClient.post<void>(`/api/v1/conversations/${conversationId}/read`, {}),
    onMutate: (conversationId: string) => {
      qc.setQueriesData<InfiniteData<ListPage>>({ queryKey: ["conversations"] }, (old) =>
        old?.pages
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                data: p.data.map((c) =>
                  c.id === conversationId ? { ...c, unread_count_for_assignee: 0 } : c,
                ),
              })),
            }
          : old,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["conversation-counts"] }),
  });
}
