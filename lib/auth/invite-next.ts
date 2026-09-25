/**
 * Extrai o token de convite de um `next` no formato `/team/accept-invite/<token>`.
 *
 * Existe porque quem chega em `/login?next=/team/accept-invite/<token>` sem
 * conta e clica "Criar conta" caía no `/signup` genérico — o token se perdia,
 * e o provisionamento, sem achar vínculo nenhum, abria uma organização nova e
 * tornava a pessoa admin dela (ver o mesmo problema já resolvido em
 * `/team/accept-invite/[token]/page.tsx`, cujo link "Ainda não tenho conta" já
 * monta `/signup?invite=<token>` corretamente — aqui é a MESMA correção,
 * faltando no outro ponto de entrada).
 */
const ACCEPT_INVITE_NEXT_RX = /^\/team\/accept-invite\/([^/]+)$/;

export function inviteTokenFromNext(next: string | undefined | null): string | null {
  if (!next) return null;
  return ACCEPT_INVITE_NEXT_RX.exec(next)?.[1] ?? null;
}
