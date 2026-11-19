/**
 * Resolução da sessão dona de um webhook da Meta.
 *
 * Existe porque o `lint-channels` me pegou: a rota `/api/v1/webhooks/meta/[token]`
 * cravava `.eq("provider", "meta_cloud")`, e nome de provider fora de
 * `lib/channels/` viola o invariante 1 da doutrina de restrição de canal.
 *
 * A tentação era pôr a rota na allowlist do lint — afinal, um endpoint de webhook
 * É inerentemente específico do provider (o protocolo da Meta não é o do WAHA).
 * Mas allowlist sem conserto é dívida silenciosa: o nome continuaria espalhado, e a
 * próxima rota copiaria o padrão. Mover a query para cá custa 20 linhas e mantém a
 * regra valendo de verdade — a rota vira transporte puro e não sabe com quem fala.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_META } from "../capabilities";

export interface MetaWebhookSession {
  id: string;
  organizationId: string;
  wabaId: string | null;
  /** `sessionRef` deste canal em todo o resto do adapter — ver `meta-cloud.ts`. */
  phoneNumberId: string | null;
  /** `byo` | `embedded_coexistence` — decide com qual App Secret a assinatura é conferida. */
  connectionMode: string | null;
}

/**
 * Sessão amarrada a este token de webhook. `null` = token desconhecido (a rota
 * responde 404 sem revelar por quê).
 *
 * O token no path é o que amarra o payload a UMA organização. O App Secret da Meta
 * é do APP e vale para todas as WABAs de todos os tenants — sozinho, ele autentica
 * a origem mas não decide o destino. Sem o token, quem conhecesse o segredo
 * escreveria em qualquer organização.
 *
 * Canal ARQUIVADO conta como token desconhecido, e essa é a única resposta
 * honesta: o usuário mandou excluir o canal. A exclusão já revoga a credencial e
 * rotaciona este token, mas o evento em voo (e a re-entrega que a plataforma faz
 * de tudo que não recebe 2xx) chegaria com o token antigo e ressuscitaria o
 * canal — criando contato, conversa e mensagem num inbox onde o operador nem
 * consegue responder, porque o arquivamento deixa a sessão STOPPED.
 */
export async function metaSessionByWebhookToken(
  token: string,
): Promise<MetaWebhookSession | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id, meta_phone_number_id, meta_connection_mode")
      .eq("webhook_path_token", token)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
    connectionMode: data.meta_connection_mode ?? null,
  };
}

/**
 * A sessão oficial ATIVA da organização (se houver). Usada pela tela de templates
 * para saber QUAL WABA espelhar — e para dizer ao operador o que fazer quando não
 * há nenhuma, em vez de mostrar uma tabela vazia sem explicação.
 *
 * Arquivada não conta: sem o filtro, a tela seguia nomeando a WABA de um canal
 * que o operador excluiu e o botão de sincronizar continuava puxando templates
 * dela — o token do env não foi revogado junto com o da linha, então a chamada
 * ia mesmo. "Excluído" que continua operando é a promessa quebrada.
 */
export async function metaSessionForOrg(
  organizationId: string,
): Promise<MetaWebhookSession | null> {
  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id, meta_phone_number_id, meta_connection_mode")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true })
      .limit(1);
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
    connectionMode: data.meta_connection_mode ?? null,
  };
}

/**
 * A sessão oficial que o operador ESCOLHEU (`channelSessionId`) — ou, sem escolha, a primeira
 * da organização (`metaSessionForOrg`), que é o comportamento de quem tem um número só.
 *
 * Com o id, só vale sessão oficial ATIVA desta organização: o id vem do browser, e quem
 * controla o browser controla o id. Id de outra org ou de canal excluído devolve `null`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function metaSessionEscolhida(
  organizationId: string,
  channelSessionId?: string | null,
): Promise<MetaWebhookSession | null> {
  if (!channelSessionId) return metaSessionForOrg(organizationId);
  if (!UUID.test(channelSessionId)) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("channel_sessions")
    .select("id, organization_id, meta_waba_id, meta_phone_number_id, meta_connection_mode")
    .eq("id", channelSessionId)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .is(ARCHIVED_AT, null)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
    connectionMode: data.meta_connection_mode ?? null,
  };
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * A linha oficial DESTE número nesta organização — ativa ou excluída —, ou `null`.
 *
 * Um canal oficial é identificado pelo número (`meta_phone_number_id`), não pela organização.
 * Achado ao vivo (B'Laser Parnamirim, 2026-11-19): conectar e reconectar procuravam "a linha
 * oficial da org" e, com um número já conectado, conectar OUTRO número regravava a linha do
 * primeiro — a Recepção virou a Clara, parou de receber e o histórico da Clara caiu nas
 * conversas dela. Reconectar o MESMO número atualiza (ou ressuscita) a linha dele; número
 * diferente nasce em linha própria.
 *
 * Ativa ganha de excluída: o índice único só barra duas ATIVAS do mesmo número, então pode
 * haver uma ativa e excluídas antigas — e a ativa é a que está em uso.
 */
export async function metaSessionDoNumero(
  admin: AdminClient,
  organizationId: string,
  phoneNumberId: string,
): Promise<{ id: string; archived_at: string | null } | null> {
  const base = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data } = await queryTolerantToMissingArchived(
    () => base(`id, ${ARCHIVED_AT}`).order(ARCHIVED_AT, { ascending: false, nullsFirst: true }).limit(1),
    () => base("id").limit(1),
  );
  const linha = ((data ?? []) as unknown as { id: string; archived_at?: string | null }[])[0];
  return linha ? { id: linha.id, archived_at: linha.archived_at ?? null } : null;
}

/**
 * Sessão ATIVA dona de uma conta de WhatsApp (WABA) ou, na falta dela, de um número.
 *
 * Serve ao endpoint global do app (`/api/v1/webhooks/meta`): a Meta entrega ali o que
 * não admite `override_callback_uri` (`account_update`, status de modelo), sem o token
 * de caminho que identifica a sessão. A WABA do evento SÓ ESCOLHE a sessão depois de a
 * assinatura ter provado a origem — nunca antes — e o resultado é sempre uma sessão que
 * o CRM já conhece: WABA desconhecida devolve `null` e o evento é ignorado.
 *
 * Só sessões em coexistência: o endpoint global confere a assinatura com o segredo do
 * app Tech Provider, e uma sessão manual (outro app) nunca deveria chegar por ele.
 */
export async function metaSessionByWabaOrPhone(input: {
  wabaId?: string | null;
  phoneNumberId?: string | null;
}): Promise<MetaWebhookSession | null> {
  const coluna = input.wabaId ? "meta_waba_id" : input.phoneNumberId ? "meta_phone_number_id" : null;
  const valor = input.wabaId || input.phoneNumberId;
  if (!coluna || !valor) return null;

  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id, meta_phone_number_id, meta_connection_mode")
      .eq(coluna, valor)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_connection_mode", "embedded_coexistence");
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
    connectionMode: data.meta_connection_mode ?? null,
  };
}
