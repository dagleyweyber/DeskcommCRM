/**
 * Montagem do payload da Meta Conversions API — função PURA (mesmo padrão
 * de `parseMetaWebhook`, testável sem rede). Quem faz I/O é `send.ts`.
 *
 * `action_source` decide por qual atribuição existe em
 * `lead.source_metadata` (Fase A): `ctwa_clid` → o lead veio de clique num
 * anúncio "Clique para o WhatsApp", que é o caso mais comum aqui —
 * `action_source: "business_messaging"` é o valor que a própria Meta
 * documenta pra esse produto. `fbclid`/`fbc`/`fbp` + navegador do visitante → veio
 * de site, `action_source: "website"` (com `client_user_agent` e `event_source_url`,
 * obrigatórios nessa fonte). Sem nenhum dos dois (lead manual/orgânico) →
 * `"system_generated"`, só com telefone hasheado — ainda manda ALGO pro
 * Meta aprender, em vez de não mandar nada.
 */
import { createHash } from "node:crypto";

export type CapiActionSource = "business_messaging" | "website" | "system_generated";

export interface CapiPayloadInput {
  eventName: string;
  /** Dedup key — o `id` da linha de event_log que originou o envio. */
  eventId: string;
  /** Unix seconds — do ACONTECIMENTO (ex.: `closed_at` do lead), não do envio. */
  eventTimeSeconds: number;
  valueCents?: number | null;
  currency?: string | null;
  /** Telefone em qualquer formato — normalizado e hasheado aqui dentro. */
  phone?: string | null;
  /** `crm_leads.source_metadata`, como veio do banco. */
  sourceMetadata?: Record<string, unknown> | null;
  /**
   * Facebook Page ID do criativo — resolvido e cacheado em
   * `meta_ads_ad_metadata` (`lib/meta-ads/ad-hierarchy.ts`). Sem ele a Meta
   * rejeita todo evento `business_messaging` (HTTP 400, subcode 2804116).
   * `null` quando o ad_id ainda não foi resolvido — o evento sai mesmo
   * assim (a Meta que recuse; melhor tentar do que não mandar nada).
   */
  pageId?: string | null;
  /**
   * WhatsApp Business Account ID — achado ao vivo (RevitaFio Mossoró,
   * subcode 2804131 "nenhuma Página associada ao conjunto de dados"):
   * `page_id` sozinho NÃO basta pra eventos de business_messaging quando o
   * conjunto de anúncios não tem um pixel/dataset configurado explicitamente
   * (comum em campanhas "Local da conversão: WhatsApp") — a Meta usa o WABA
   * pra resolver a associação Página↔conjunto de dados nesse caso. Manda OS
   * DOIS quando existirem (não é um substituto do page_id, é complementar —
   * já tínhamos page_id certo e ainda assim falhava). `channel_sessions.
   * meta_waba_id` já guarda isso pra quem conectou Meta Cloud API oficial —
   * mesma fonte que preenche os templates.
   */
  whatsappBusinessAccountId?: string | null;
  /** E-mail do contato — normalizado e hasheado aqui dentro (`user_data.em`). */
  email?: string | null;
  /** Identificador estável do cliente no CRM (id do contato) — hasheado (`user_data.external_id`). */
  externalId?: string | null;
  /**
   * O ponto de contato do lead (`lead_touchpoints`, Fase 1 do rastreamento) — tem
   * precedência sobre `sourceMetadata` para clique, cookies do Pixel e dados do
   * navegador, porque foi gravado do jeito que a Meta espera (fbc com a hora do clique).
   */
  atribuicao?: AtribuicaoParaCapi | null;
}

export interface AtribuicaoParaCapi {
  clickIdType: string | null;
  clickId: string | null;
  fbc: string | null;
  fbp: string | null;
  clientUserAgent: string | null;
  eventSourceUrl: string | null;
  /** Milissegundos do clique — para montar o fbc a partir do fbclid. */
  clickTimeMs: number | null;
}

/**
 * Nome do evento aceito em conversas de WhatsApp (`business_messaging`).
 *
 * Medido em produção (RevitaFio Mossoró, 85 recusas): a Meta recusa "Lead" nessa fonte
 * com o subcode 2804066 e sugere, na própria mensagem, "LeadSubmitted". O vocabulário
 * das etapas do funil continua o mesmo (o tenant escolhe "Lead qualificado"); a
 * tradução acontece só na hora de enviar, e só para essa fonte.
 */
export function nomeDoEventoPara(actionSource: CapiActionSource, eventName: string): string {
  if (actionSource === "business_messaging" && eventName === "Lead") return "LeadSubmitted";
  return eventName;
}

export interface CapiEventPayload {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: CapiActionSource;
  messaging_channel?: "whatsapp";
  event_source_url?: string;
  user_data: {
    ph?: [string];
    em?: [string];
    external_id?: [string];
    client_user_agent?: string;
    ctwa_clid?: string;
    page_id?: string;
    whatsapp_business_account_id?: string;
    fbc?: string;
    fbp?: string;
  };
  custom_data?: {
    value: number;
    currency: string;
  };
}

/** SHA-256 hex do telefone normalizado (só dígitos, sem `+`) — formato que a Meta exige em `user_data.ph`. */
function hashPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return createHash("sha256").update(digits).digest("hex");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export function buildCapiPayload(input: CapiPayloadInput): CapiEventPayload {
  const meta = input.sourceMetadata ?? {};
  const at = input.atribuicao ?? null;

  const ctwaClid =
    (at?.clickIdType === "ctwa_clid" ? str(at.clickId) : null) ??
    str(meta.ad_click_id_type === "ctwa_clid" ? meta.ad_click_id : null);
  const fbclid = (at?.clickIdType === "fbclid" ? str(at.clickId) : null) ?? str(meta.fbclid);
  const fbp = str(at?.fbp) ?? str(meta.fbp);
  // fbc é `fb.1.<MILISSEGUNDOS do clique>.<fbclid>`. Antes, o fallback usava os
  // SEGUNDOS da hora da venda — um fbc com data errada, e a data é parte do casamento
  // do clique. Agora: o valor gravado no clique; senão, montado com a hora do clique.
  let fbc = str(at?.fbc) ?? str(meta.fbc);
  if (!fbc && fbclid) {
    const ms = at?.clickTimeMs ?? input.eventTimeSeconds * 1000;
    fbc = `fb.1.${ms}.${fbclid}`;
  }
  const userAgent = str(at?.clientUserAgent) ?? str(meta.client_user_agent);
  const sourceUrl = str(at?.eventSourceUrl) ?? str(meta.landing_url) ?? str(meta.page_url);

  const userData: CapiEventPayload["user_data"] = {};
  if (input.phone) userData.ph = [hashPhone(input.phone)];

  let actionSource: CapiActionSource;
  let messagingChannel: "whatsapp" | undefined;
  let eventSourceUrl: string | undefined;
  if (ctwaClid) {
    actionSource = "business_messaging";
    messagingChannel = "whatsapp";
    userData.ctwa_clid = ctwaClid;
    if (input.pageId) userData.page_id = input.pageId;
    if (input.whatsappBusinessAccountId) {
      userData.whatsapp_business_account_id = input.whatsappBusinessAccountId;
    }
  } else {
    // Evento de site exige, pela documentação da Meta, o navegador do visitante
    // (`client_user_agent`) e a página (`event_source_url`). Sem o navegador o evento
    // sai como "gerado pelo sistema" — ainda com fbc/fbp, que servem de casamento —
    // em vez de um evento de site incompleto.
    actionSource = (fbc || fbp) && userAgent ? "website" : "system_generated";
    if (fbc) userData.fbc = fbc;
    if (fbp) userData.fbp = fbp;
    if (actionSource === "website" && userAgent) {
      userData.client_user_agent = userAgent;
      if (sourceUrl) eventSourceUrl = sourceUrl;
    }
    // Mais sinais de casamento (Event Match Quality). Fora do ramo de mensagem de
    // propósito: lá a Meta casa pelo ctwa_clid, e campo a mais é risco de recusa nova.
    const email = str(input.email)?.trim().toLowerCase();
    if (email) userData.em = [sha256(email)];
    const externalId = str(input.externalId);
    if (externalId) userData.external_id = [sha256(externalId)];
  }

  const payload: CapiEventPayload = {
    event_name: nomeDoEventoPara(actionSource, input.eventName),
    event_time: input.eventTimeSeconds,
    event_id: input.eventId,
    action_source: actionSource,
    user_data: userData,
  };
  if (eventSourceUrl) payload.event_source_url = eventSourceUrl;
  if (messagingChannel) payload.messaging_channel = messagingChannel;
  if (input.valueCents != null && input.currency) {
    payload.custom_data = { value: input.valueCents / 100, currency: input.currency };
  }
  return payload;
}
