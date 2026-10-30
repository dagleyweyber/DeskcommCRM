/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → toda contagem HERDA a RLS de
 * SELECT de `conversations` (fn_can_view_conversation, migration 0035). Um agent
 * em modo own* recebe a contagem do SEU escopo, NUNCA o total da org — a mesma
 * garantia do listing. Uma única chamada (fn_conversation_counts, security invoker) devolve as três contagens.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "No active organization.", 403, { requestId });
  }

  // Com um número selecionado no inbox, os badges das abas contam só as conversas
  // dele — a lista já filtrava (`channel_session_id` em /api/v1/conversations) e os
  // badges não, então "Todas 987" aparecia sobre uma lista de 152. Badge que não
  // bate com a lista que ele rotula manda o atendente atrás de trabalho inexistente.
  const canalParam = new URL(req.url).searchParams.get("channel_session_id");
  if (canalParam !== null && !z.string().uuid().safeParse(canalParam).success) {
    return fail("validation_failed", "channel_session_id inválido.", 422, { requestId });
  }

  // UMA leitura (fn_conversation_counts, migration 0208) no lugar de três count(*):
  // cada um varria a organização inteira sob RLS, a cada 30 s por aba aberta, e
  // esgotava o pool do PostgREST. Espelha tabToFilter (InboxLayout): fila = abertas
  // sem dono; minhas = atribuídas a mim e ainda ABERTAS; todas = tudo que o usuário VÊ.
  //
  // Os estados terminais saem de CONVERSATION_TERMINAL_STATUSES — a MESMA constante
  // do `exclude_finished` da aba — e viajam por parâmetro: o SQL não guarda uma
  // segunda lista que pudesse divergir. Badge que conta o que a aba não mostra é
  // pior que badge nenhum — manda o atendente atrás de um trabalho que não existe.
  const { data, error } = await supabase.rpc(
    "fn_conversation_counts" as never,
    {
      p_org: activeOrg.orgId,
      p_channel_session_id: canalParam,
      p_terminal_statuses: [...CONVERSATION_TERMINAL_STATUSES],
    } as never,
  );
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const linha = (Array.isArray(data) ? data[0] : data) as
    | { unassigned: number | string | null; mine: number | string | null; total: number | string | null }
    | null
    | undefined;

  return ok(
    {
      unassigned: Number(linha?.unassigned ?? 0),
      mine: Number(linha?.mine ?? 0),
      all: Number(linha?.total ?? 0),
    },
    { requestId },
  );
}
