/**
 * Melhor esforço: já existe conta Supabase Auth para este e-mail?
 *
 * Existe porque `/team/accept-invite/[token]` mostrava "Fazer login" e "Ainda
 * não tenho conta" com o MESMO peso visual pra quem nunca tem como saber qual
 * clicar — e quem está sendo convidado pela primeira vez (o caso mais comum
 * desta tela: dono de tenant novo) naturalmente clica no botão grande
 * ("Fazer login"), que falha porque não existe conta nenhuma ainda. A tela
 * precisa saber, pra destacar a ação certa.
 *
 * Mesmo trade-off de `app/actions/auth/useRecoveryCode.ts`: a API admin desta
 * versão do GoTrue não filtra `listUsers` por e-mail, então pagina os
 * primeiros N (instalação self-host, poucas centenas de usuários no total) e
 * procura. `null` = não deu pra saber (sem service role configurado, ou erro
 * na chamada) — quem chama DEGRADA pra "não sei", nunca esconde um caminho.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function accountExistsForEmail(
  admin: SupabaseClient,
  email: string,
): Promise<boolean | null> {
  const target = email.trim().toLowerCase();
  if (target === "") return null;
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error || !data) return null;
  return data.users.some((u) => u.email?.trim().toLowerCase() === target);
}
