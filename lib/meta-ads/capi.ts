/**
 * Montagem do payload da Meta Conversions API — função PURA (mesmo padrão
 * de `parseMetaWebhook`, testável sem rede). Quem faz I/O é `send.ts`.
 *
 * `action_source` decide por qual atribuição existe em
 * `lead.source_metadata` (Fase A): `ctwa_clid` → o lead veio de clique num
 * anúncio "Clique para o WhatsApp", que é o caso mais comum aqui —
 * `action_source: "business_messaging"` é o valor que a própria Meta
 * documenta pra esse produto. `fbclid`/`fbc`/`fbp` → veio de site/Typebot,
 * `action_source: "website"`. Sem nenhum dos dois (lead manual/orgânico) →
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
}

export interface CapiEventPayload {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: CapiActionSource;
  messaging_channel?: "whatsapp";
  user_data: {
    ph?: [string];
    ctwa_clid?: string;
    page_id?: string;
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

export function buildCapiPayload(input: CapiPayloadInput): CapiEventPayload {
  const meta = input.sourceMetadata ?? {};
  const ctwaClid = str(meta.ad_click_id_type === "ctwa_clid" ? meta.ad_click_id : null);
  const fbclid = str(meta.fbclid);
  const fbc = str(meta.fbc);
  const fbp = str(meta.fbp);

  const userData: CapiEventPayload["user_data"] = {};
  if (input.phone) userData.ph = [hashPhone(input.phone)];

  let actionSource: CapiActionSource;
  let messagingChannel: "whatsapp" | undefined;
  if (ctwaClid) {
    actionSource = "business_messaging";
    messagingChannel = "whatsapp";
    userData.ctwa_clid = ctwaClid;
    if (input.pageId) userData.page_id = input.pageId;
  } else if (fbc || fbp || fbclid) {
    actionSource = "website";
    // `fbclid` sozinho (sem cookie do Pixel) ainda serve de match — a Meta
    // aceita no formato `fb.1.<timestamp>.<fbclid>` como `fbc` de fallback.
    if (fbc) userData.fbc = fbc;
    if (fbp) userData.fbp = fbp;
    if (!fbc && fbclid) userData.fbc = `fb.1.${input.eventTimeSeconds}.${fbclid}`;
  } else {
    actionSource = "system_generated";
  }

  const payload: CapiEventPayload = {
    event_name: input.eventName,
    event_time: input.eventTimeSeconds,
    event_id: input.eventId,
    action_source: actionSource,
    user_data: userData,
  };
  if (messagingChannel) payload.messaging_channel = messagingChannel;
  if (input.valueCents != null && input.currency) {
    payload.custom_data = { value: input.valueCents / 100, currency: input.currency };
  }
  return payload;
}
