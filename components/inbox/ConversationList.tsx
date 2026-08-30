"use client";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

interface Props {
  filters: ConversationsFilters;
  orgId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional client-side filter (e.g. only-unread). */
  clientFilter?: (c: ConversationWithContact) => boolean;
  /** Notifies parent when the visible list changes (used by keyboard nav). */
  onVisibleChange?: (ids: string[]) => void;
}

export function ConversationList({
  filters,
  orgId,
  selectedId,
  onSelect,
  clientFilter,
  onVisibleChange,
}: Props) {
  // Só mostra POR ONDE a conversa entrou quando há mais de um número. Com um
  // só, o rótulo seria a mesma palavra em toda linha — ruído que ensina o olho
  // a ignorar a área onde vivem os avisos que importam.
  //
  // `?? []` e não `undefined`: enquanto a lista de canais carrega, o certo é
  // NÃO mostrar. Mostrar e sumir depois é pior que aparecer um instante tarde.
  const canais = useChannelSessions().data ?? [];
  const maisDeUmCanal = canais.length > 1;

  // Nome de quem assumiu — pedido do dono da agência: admin e outros
  // atendentes verem QUEM está conduzindo cada conversa sem abrir uma a uma.
  // Mesmo mapa já usado em ReassignDialog/Kanban (uma fonte só pra uuid→nome).
  const membros = useAssignableMembers(true).data ?? [];
  const nomePorUserId = useMemo(() => {
    const m = new Map<string, string>();
    for (const membro of membros) if (membro.full_name) m.set(membro.user_id, membro.full_name);
    return m;
  }, [membros]);

  const q = useConversationsRealtime(filters, orgId);

  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  const isQueue = filters.assigned_to === "unassigned";

  const items = useMemo(() => {
    const all: ConversationWithContact[] = q.data?.pages.flatMap((p) => p.data) ?? [];
    return clientFilter ? all.filter(clientFilter) : all;
  }, [q.data, clientFilter]);

  // Notify parent of currently-visible IDs (for j/k nav). Must use effect
  // (not render-time call) — invoking onVisibleChange during render triggers
  // setState in InboxLayout from inside ConversationList's render phase,
  // which React 19 forbids.
  useEffect(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>Erro ao carregar conversas.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyInbox />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {items.map((c, i) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
            queuePosition={isQueue ? i + 1 : undefined}
            mostrarCanal={maisDeUmCanal}
            assigneeName={
              c.assignee_kind === "user" && c.assigned_to_user_id
                ? (nomePorUserId.get(c.assigned_to_user_id) ?? null)
                : null
            }
          />
        ))}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
