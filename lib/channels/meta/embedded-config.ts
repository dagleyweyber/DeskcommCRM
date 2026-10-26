/**
 * Modo "Conectar com a Meta" (Embedded Signup + Coexistência) — OPCIONAL por
 * instalação.
 *
 * ─── Por que existe um modo que a doutrina já recusou ───────────────────────
 * `docs/doctrine/restricao-de-canal.md` recusa Embedded Signup como substituto do
 * BYO num produto self-host: exigiria que cada instalador virasse Tech Provider.
 * A emenda de 2026-10-23 da mesma doutrina o admite COMO MODO ADICIONAL, ligado só
 * em instalação cujo dono é Tech Provider (app com Advanced Access aprovado). O
 * BYO continua sendo o padrão e o único modo de quem não configura nada disto.
 *
 * ─── O contrato ─────────────────────────────────────────────────────────────
 * `null` = o modo não existe nesta instalação: a tela não mostra o botão e a API
 * recusa. Nunca é erro — instalação sem as variáveis é o caso normal, e é o que
 * mantém `update.sh`/instalação fresca funcionando sem editar `.env`.
 *
 * Exige as TRÊS variáveis juntas (todas com prefixo `META_EMBEDDED_`). O App Secret entra na conta (sem ele o servidor
 * não troca o `code` por token nem valida a assinatura do webhook, então o botão
 * abriria um fluxo que nunca conclui), mas NUNCA sai daqui: o retorno só leva o que
 * o navegador precisa para abrir o popup (`appId` e `configId`, ambos públicos).
 */
export interface EmbeddedSignupConfig {
  appId: string;
  configId: string;
}

export function embeddedSignupConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddedSignupConfig | null {
  const appId = env.META_EMBEDDED_APP_ID?.trim();
  const appSecret = env.META_EMBEDDED_APP_SECRET?.trim();
  const configId = env.META_EMBEDDED_CONFIG_ID?.trim();
  if (!appId || !appSecret || !configId) return null;
  return { appId, configId };
}

/**
 * App Secret que ASSINA o webhook de uma sessão, escolhido pelo MODO dela.
 *
 * Por que não existe um segredo só: o Embedded Signup roda num app Meta PRÓPRIO (o do
 * Tech Provider), e as sessões BYO já existentes usam OUTRO app. A Meta assina cada
 * entrega com o segredo do app dono da WABA — então um `META_APP_SECRET` global
 * rejeitaria (401) o webhook de um dos dois grupos. Sessão em coexistência verifica
 * com o segredo do app embutido; qualquer outra, com o `META_APP_SECRET` de sempre,
 * que é o que mantém as sessões atuais funcionando sem tocar em nada.
 */
export function appSecretDoWebhook(
  modo: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const segredo =
    modo === "embedded_coexistence" ? env.META_EMBEDDED_APP_SECRET : env.META_APP_SECRET;
  return segredo?.trim() ?? "";
}
