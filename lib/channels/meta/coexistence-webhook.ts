/**
 * Webhooks da COEXISTÊNCIA — parse **puro e síncrono**, mesmo contrato de
 * `webhook.ts` (nada aqui toca banco ou rede).
 *
 * Quatro campos entram quando o número convive com o app WhatsApp Business:
 *   - `smb_message_echoes`  — o que o dono digitou no celular (SAÍDA, não entrada);
 *   - `history`             — as conversas anteriores, em blocos fora de ordem;
 *   - `smb_app_state_sync`  — a agenda de contatos do app;
 *   - `account_update`      — a Meta o entrega sempre na URL PADRÃO do app, nunca no
 *                             `override_callback_uri` da sessão; por isso quem o recebe
 *                             é o endpoint global (`/api/v1/webhooks/meta`), que acha a
 *                             clínica pela WABA.
 *
 * Mesma regra do resto do canal: **campo/tipo desconhecido é ignorado, nunca erro**.
 * A Meta re-entrega tudo que não recebe 2xx; recusar o que não entendemos vira
 * re-tentativa em backoff por horas.
 */

import { ehBsuid } from "./endereco";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A Meta manda epoch em SEGUNDOS, às vezes string, às vezes número. */
function epoch(v: unknown): Date {
  const n = typeof v === "number" ? v : Number(str(v) ?? "0");
  return new Date((Number.isFinite(n) ? n : 0) * 1000);
}

export interface MidiaRecebida {
  id: string;
  mime: string | null;
  /** Nota de voz de verdade (e não anexo de áudio). */
  voice?: boolean;
}

/** Mensagem que o dono mandou pelo app do celular (ou aparelho pareado). */
export interface EchoEvent {
  kind: "echo";
  wabaId: string;
  /** Qual número NOSSO — amarra o eco à sessão (nunca ao corpo). */
  phoneNumberId: string;
  /** `wamid`. A chave de idempotência — e o que casa com o envio do próprio CRM. */
  externalId: string;
  /**
   * O CONTATO (destinatário). `from` é o número do negócio e nunca vira contato.
   * `null` quando a Meta omite o telefone — aí `toUserId` (BSUID) identifica a pessoa.
   */
  to: string | null;
  toUserId: string | null;
  sentAt: Date;
  type: string;
  text: string | null;
  media: MidiaRecebida | null;
}

/** Um contato da agenda do app mudou. Só enriquecemos quem JÁ é nosso contato. */
export interface ContactSyncEvent {
  kind: "contact_sync";
  wabaId: string;
  phoneNumberId: string;
  action: "add" | "remove";
  phone: string;
  fullName: string | null;
}

export interface HistoricoMensagem {
  externalId: string;
  /** `true` = o contato escreveu. Decidido por quem é `from` na conversa. */
  inbound: boolean;
  sentAt: Date;
  type: string;
  text: string | null;
  media: MidiaRecebida | null;
  /** `history_context.status`: DELIVERED | ERROR | PENDING | PLAYED | READ | SENT. */
  status: string | null;
}

export interface HistoricoConversa {
  /** Telefone do contato (o `id` da thread), ou `null` quando a thread é identificada por BSUID. */
  contactPhone: string | null;
  /** BSUID do contato, quando o `id` da thread é um BSUID. */
  contactUserId: string | null;
  messages: HistoricoMensagem[];
}

/** Um bloco do histórico. Chegam FORA de ordem e podem trazer milhares de mensagens. */
export interface HistoryChunkEvent {
  kind: "history_chunk";
  wabaId: string;
  phoneNumberId: string;
  /** 0, 1 ou 2 — a fase só está completa quando chega a 2. */
  phase: number | null;
  chunkOrder: number | null;
  /** 0–100; a sincronização inteira só termina em 100. */
  progress: number | null;
  threads: HistoricoConversa[];
}

/** O cliente recusou compartilhar o histórico (erro 2593109). */
export interface HistoryDeclinedEvent {
  kind: "history_declined";
  wabaId: string;
  phoneNumberId: string;
  code: number | null;
}

/**
 * Aviso da CONTA (`account_update`): desconexão, banimento, restrição, volta.
 *
 * Guarda só o que decide algo — o nome do evento e os poucos campos de que a tradução
 * em saúde/aviso precisa. O corpo inteiro não é copiado: traz IDs de negócio que não
 * vão a lugar nenhum.
 */
export interface AccountUpdateEvent {
  kind: "account_update";
  wabaId: string;
  /** `value.event`: PARTNER_REMOVED, DISABLED_UPDATE, ACCOUNT_RECONNECTED… */
  event: string;
  /** `ban_info.waba_ban_state` (DISABLE | REINSTATE | SCHEDULE_FOR_DISABLE), em DISABLED_UPDATE. */
  banState: string | null;
  /** `disconnection_info.reason` (PARTNER_REMOVED): CHANGE_NUMBER, PRIMARY_INACTIVITY… */
  disconnectReason: string | null;
  /** `disconnection_info.initiated_by`: USER | SYSTEM. */
  disconnectInitiatedBy: string | null;
  /** `violation_info.violation_type` (ACCOUNT_VIOLATION). */
  violationType: string | null;
  /** `restriction_info[0].restriction_type` (ACCOUNT_RESTRICTION). */
  restrictionType: string | null;
}

/**
 * Mensagem de MÍDIA do histórico que chega fora do bloco principal: campo `history`
 * sem `threads`, com `messages[]` (do contato) ou `message_echoes[]` (nossas). É a
 * mensagem em si — não um complemento de algo que já importamos (ver
 * `ingestHistoryMedia`).
 */
export interface HistoryMediaEvent {
  kind: "history_media";
  wabaId: string;
  phoneNumberId: string;
  externalId: string;
  /** `messages[]` = o contato escreveu; `message_echoes[]` = a clínica enviou. */
  inbound: boolean;
  /** Telefone do CONTATO (`from` na entrada, `to` na saída); `null` quando a Meta o omite. */
  phone: string | null;
  /** BSUID do contato (`from_user_id` / `to_user_id`). */
  userId: string | null;
  sentAt: Date;
  type: string;
  text: string | null;
  media: MidiaRecebida;
}

export type CoexistenceEvent =
  | HistoryMediaEvent
  | EchoEvent
  | ContactSyncEvent
  | HistoryChunkEvent
  | HistoryDeclinedEvent
  | AccountUpdateEvent;

function midiaDe(raw: Record<string, unknown>, tipo: string): MidiaRecebida | null {
  const corpo = raw[tipo] as Record<string, unknown> | undefined;
  const id = str(corpo?.id);
  return id
    ? { id, mime: str(corpo?.mime_type), ...(corpo?.voice === true ? { voice: true } : {}) }
    : null;
}

function textoDe(raw: Record<string, unknown>, tipo: string): string | null {
  if (tipo === "text") return str((raw.text as Record<string, unknown> | undefined)?.body);
  // Legenda de mídia É o texto que o dono escreveu — sem ela a mensagem apareceria vazia.
  const corpo = raw[tipo] as Record<string, unknown> | undefined;
  return str(corpo?.caption);
}

/**
 * Tipos do eco que viram mensagem. `revoke` (apagou) e `edit` (editou) mexem numa
 * mensagem que já existe; tratá-los como mensagem nova inventaria uma linha — e o
 * efeito certo (apagar/editar a original) é decisão de produto que não está aqui.
 */
// `sticker` entra: figurinha enviada pelo celular da clínica é mensagem como as outras (e a
// Meta já a entrega pelo eco). Sem ele, esse eco era descartado em silêncio.
const TIPOS_DE_ECO_QUE_VIRAM_MENSAGEM = new Set(["text", "image", "video", "document", "audio", "sticker"]);

export function parseEchoes(
  wabaId: string,
  value: Record<string, unknown>,
): EchoEvent[] {
  const meta = (value.metadata ?? {}) as Record<string, unknown>;
  const phoneNumberId = str(meta.phone_number_id) ?? "";
  const lista = Array.isArray(value.message_echoes)
    ? (value.message_echoes as Record<string, unknown>[])
    : [];
  const out: EchoEvent[] = [];
  for (const raw of lista) {
    const id = str(raw.id);
    const to = str(raw.to);
    const toUserId = str(raw.to_user_id);
    const tipo = str(raw.type) ?? "unknown";
    if (!id || (!to && !toUserId) || !TIPOS_DE_ECO_QUE_VIRAM_MENSAGEM.has(tipo)) continue;
    out.push({
      kind: "echo",
      wabaId,
      phoneNumberId,
      externalId: id,
      to,
      toUserId,
      sentAt: epoch(raw.timestamp),
      type: tipo,
      text: textoDe(raw, tipo),
      media: midiaDe(raw, tipo),
    });
  }
  return out;
}

export function parseContactSync(
  wabaId: string,
  value: Record<string, unknown>,
): ContactSyncEvent[] {
  const meta = (value.metadata ?? {}) as Record<string, unknown>;
  const phoneNumberId = str(meta.phone_number_id) ?? "";
  const lista = Array.isArray(value.state_sync)
    ? (value.state_sync as Record<string, unknown>[])
    : [];
  const out: ContactSyncEvent[] = [];
  for (const raw of lista) {
    if (raw.type !== "contact") continue;
    const contato = (raw.contact ?? {}) as Record<string, unknown>;
    const phone = str(contato.phone_number);
    const action = raw.action === "add" || raw.action === "remove" ? raw.action : null;
    if (!phone || !action) continue;
    out.push({
      kind: "contact_sync",
      wabaId,
      phoneNumberId,
      action,
      phone,
      fullName: str(contato.full_name) ?? str(contato.first_name),
    });
  }
  return out;
}

/**
 * `history`: dois formatos, porque a documentação da própria Meta é inconsistente
 * (o exemplo de erro vem SEM o envelope `entry/changes`, e o de mídia põe `messages`
 * direto em `value`). Aceitamos o envelope normal e o `history` solto no topo —
 * quem parseia não pode depender de qual exemplo estava certo naquele dia.
 */
export function parseHistory(
  wabaId: string,
  value: Record<string, unknown>,
): Array<HistoryChunkEvent | HistoryDeclinedEvent> {
  const meta = (value.metadata ?? {}) as Record<string, unknown>;
  const phoneNumberId = str(meta.phone_number_id) ?? "";
  const blocos = Array.isArray(value.history) ? (value.history as Record<string, unknown>[]) : [];
  const out: Array<HistoryChunkEvent | HistoryDeclinedEvent> = [];

  for (const bloco of blocos) {
    const erros = Array.isArray(bloco.errors) ? (bloco.errors as Record<string, unknown>[]) : [];
    if (erros.length > 0) {
      const codigo = erros[0]!.code;
      out.push({
        kind: "history_declined",
        wabaId,
        phoneNumberId,
        code: typeof codigo === "number" ? codigo : null,
      });
      continue;
    }

    const m = (bloco.metadata ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const threads: HistoricoConversa[] = [];
    for (const t of Array.isArray(bloco.threads) ? (bloco.threads as Record<string, unknown>[]) : []) {
      const threadId = str(t.id);
      if (!threadId) continue;
      // O `id` da thread é o telefone do contato — ou, para quem a Meta identifica só
      // pelo BSUID, o próprio BSUID.
      const contactUserId = ehBsuid(threadId) ? threadId : null;
      const contactPhone = contactUserId ? null : threadId;
      const messages: HistoricoMensagem[] = [];
      for (const raw of Array.isArray(t.messages) ? (t.messages as Record<string, unknown>[]) : []) {
        const id = str(raw.id);
        if (!id) continue;
        const tipo = str(raw.type) ?? "unknown";
        messages.push({
          externalId: id,
          // `from` é o telefone do contato (mensagem dele) ou o do negócio (nossa).
          inbound: str(raw.from) === threadId || str(raw.from_user_id) === threadId,
          sentAt: epoch(raw.timestamp),
          type: tipo,
          text: textoDe(raw, tipo),
          media: midiaDe(raw, tipo),
          status: str((raw.history_context as Record<string, unknown> | undefined)?.status),
        });
      }
      if (messages.length > 0) threads.push({ contactPhone, contactUserId, messages });
    }
    out.push({
      kind: "history_chunk",
      wabaId,
      phoneNumberId,
      phase: num(m.phase),
      chunkOrder: num(m.chunk_order),
      progress: num(m.progress),
      threads,
    });
  }
  return out;
}

export function parseAccountUpdate(
  wabaId: string,
  value: Record<string, unknown>,
): AccountUpdateEvent[] {
  const event = str(value.event);
  if (!event) return [];
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const ban = obj(value.ban_info);
  const desconexao = obj(value.disconnection_info);
  const violacao = obj(value.violation_info);
  const restricoes = Array.isArray(value.restriction_info) ? (value.restriction_info as unknown[]) : [];
  // `waba_info.waba_id` é o id da conta nos eventos de parceiro; `entry.id` nos demais.
  const wabaDoEvento = str(obj(value.waba_info).waba_id) ?? wabaId;
  return [
    {
      kind: "account_update",
      wabaId: wabaDoEvento,
      event,
      banState: str(ban.waba_ban_state)
        ?? (Array.isArray(ban.waba_ban_state) ? str((ban.waba_ban_state as unknown[])[0]) : null),
      disconnectReason: str(desconexao.reason),
      disconnectInitiatedBy: str(desconexao.initiated_by),
      violationType: str(violacao.violation_type),
      restrictionType: str(obj(restricoes[0]).restriction_type),
    },
  ];
}

const TIPOS_DE_MIDIA_DO_HISTORICO = new Set(["image", "video", "audio", "document", "sticker"]);

export function parseHistoryMedia(
  wabaId: string,
  value: Record<string, unknown>,
): HistoryMediaEvent[] {
  const meta = (value.metadata ?? {}) as Record<string, unknown>;
  const phoneNumberId = str(meta.phone_number_id) ?? "";
  const out: HistoryMediaEvent[] = [];
  for (const [lista, inbound] of [
    ["messages", true],
    ["message_echoes", false],
  ] as const) {
    const itens = Array.isArray(value[lista]) ? (value[lista] as Record<string, unknown>[]) : [];
    for (const raw of itens) {
      const id = str(raw.id);
      const tipo = str(raw.type) ?? "unknown";
      if (!id || !TIPOS_DE_MIDIA_DO_HISTORICO.has(tipo)) continue;
      const media = midiaDe(raw, tipo);
      if (!media) continue;
      const phone = inbound ? str(raw.from) : str(raw.to);
      const userId = inbound ? str(raw.from_user_id) : str(raw.to_user_id);
      // Sem NENHUM identificador do contato não há conversa a que ligar a mensagem.
      if (!phone && !userId) continue;
      out.push({
        kind: "history_media",
        wabaId,
        phoneNumberId,
        externalId: id,
        inbound,
        phone,
        userId,
        sentAt: epoch(raw.timestamp),
        type: tipo,
        text: textoDe(raw, tipo),
        media,
      });
    }
  }
  return out;
}

/** Despacha um `change` para o parser do campo. Campo que não é daqui devolve `[]`. */
export function parseCoexistenceChange(
  field: string | undefined,
  wabaId: string,
  value: Record<string, unknown>,
): CoexistenceEvent[] {
  if (field === "smb_message_echoes") return parseEchoes(wabaId, value);
  if (field === "smb_app_state_sync") return parseContactSync(wabaId, value);
  // `history` tem DUAS formas: o bloco principal (`history[].threads`) e a mídia solta
  // (`messages[]`/`message_echoes[]`). Os dois parsers se ignoram quando a forma não é a sua.
  if (field === "history") return [...parseHistory(wabaId, value), ...parseHistoryMedia(wabaId, value)];
  if (field === "account_update") return parseAccountUpdate(wabaId, value);
  return [];
}

/**
 * O `history` de recusa chega SEM `object/entry/changes` (doc da Meta). Este é o
 * único caminho que olha o corpo cru — o resto passa pelo envelope normal.
 */
export function parseHistoryDeclinedTopLevel(body: unknown): HistoryDeclinedEvent[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (b.object !== undefined || !Array.isArray(b.history)) return [];
  return parseHistory("", b).filter((e): e is HistoryDeclinedEvent => e.kind === "history_declined");
}
