/**
 * "Este e-mail já tem conta?" — a pergunta que a PESSOA não deveria precisar
 * responder.
 *
 * Ver o cabeçalho da migration 0188 para o incidente que originou isto: a tela
 * do convite oferecia "Fazer login" e "Ainda não tenho conta", e quem escolhia
 * errado ficava preso permanentemente (o signup não atualiza `user_metadata`
 * de conta existente, então o token velho e expirado é o que sobrevive).
 *
 * `listUsers()` não serve: baixa o diretório paginado e compara em memória —
 * caro, e com teto. Com 50 clínicas e seus times, "só os 200 primeiros" vira
 * resposta errada silenciosa. A RPC é exata e usa o índice de e-mail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * `true`/`false` quando dá para saber; `null` quando a consulta falhou.
 *
 * O `null` é parte do contrato, não descuido: quem chama precisa poder
 * DEGRADAR em vez de adivinhar. Chutar "não tem conta" devolveria a armadilha
 * original justamente no dia em que o banco está ruim.
 */
export async function emailTemConta(
  admin: SupabaseClient,
  email: string,
): Promise<boolean | null> {
  const alvo = email.trim().toLowerCase();
  if (!alvo) return null;

  const { data, error } = await admin.rpc("fn_email_tem_conta" as never, {
    p_email: alvo,
  } as never);

  if (error) {
    logger.error("[conta-existente] fn_email_tem_conta falhou", { error: error.message });
    return null;
  }
  return data === true;
}
