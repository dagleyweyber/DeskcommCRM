/**
 * Conversa importada do histórico: nasce FECHADA e volta a abrir quando alguém fala.
 *
 * Por que existe — a primeira conexão real em coexistência importou 528 conversas
 * abertas e sem dono, e a Fila da recepção foi de 60 para 588. Histórico é passado:
 * entra `closed`, com a marca \`metadata.origem = 'historico_importado'\`.
 *
 * Fechar sem reabrir esconderia a próxima mensagem do cliente. A reabertura é uma
 * função SQL (migration 0197) e não um UPDATE do app por três razões: é atômica (duas
 * mensagens simultâneas reabrem UMA vez e emitem UM pedido de roteamento), só toca
 * conversa fechada E marcada (a que a clínica fechou à mão não muda), e emite o
 * evento de roteamento que o gatilho de 0040 não emite porque só olha INSERT.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Marca de linha/conversa importada. A migration 0196 (mensagens) e a 0197
 * (conversas) leem esta MESMA string — mudar um lado sem o outro reabre a enxurrada.
 */
export const ORIGEM_HISTORICO = "historico_importado";

/**
 * Reabre a conversa SE ela foi importada e ainda está fechada. Falha não derruba a
 * ingestão: a mensagem já entrou, e perder a reabertura é um defeito de visibilidade
 * que o aviso no log torna contável, não um motivo para recusar a mensagem do cliente.
 */
export async function reabrirConversaImportada(
  admin: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("fn_reabrir_conversa_importada" as never, {
    p_conv: conversationId,
  } as never);
  if (error) {
    logger.warn("[meta.conversa-importada] reabertura falhou", {
      conversation_id: conversationId,
      detail: error.message,
    });
    return false;
  }
  return data === true;
}
