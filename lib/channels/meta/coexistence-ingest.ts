/**
 * Ingestão dos eventos da COEXISTÊNCIA — o que o app do celular produz.
 *
 * ─── A regra que organiza este arquivo ─────────────────────────────────────
 * Nada daqui chama `aplicarEfeitosPosEntrada`. Aquele passo faz opt-out, cria lead
 * e ACORDA O AGENTE — corretos para uma mensagem que o cliente acabou de mandar,
 * errados para as três coisas que chegam aqui:
 *   - o ECO é o próprio dono respondendo: a IA responder por cima dele seria
 *     atropelar um humano que já está atendendo;
 *   - o HISTÓRICO é passado: não pode criar lead nem disparar bot por conversa
 *     de seis meses atrás;
 *   - a AGENDA do app é pessoal (família, fornecedores): não vira contato do CRM.
 *
 * ─── O que NÃO renova a janela de 24h ──────────────────────────────────────
 * A janela da Cloud API abre por mensagem do CLIENTE. Eco é saída, e o histórico não
 * toca `last_inbound_at`/`last_outbound_at`/`unread_count_for_assignee` de
 * propósito: errar para o lado conservador (janela "fechada" → usa template) é
 * inofensivo; errar para o outro lado manda texto livre que a Meta recusa.
 *
 * ─── Eventos de banco ──────────────────────────────────────────────────────
 * `trg_messages_emit_event` emite `message.received` para TODA mensagem inserida,
 * e os consumidores (sentimento pago, automações do usuário, follow-up, IA) rodam
 * nela. Linha do histórico leva `metadata.origem = 'historico_importado'` e a
 * migration 0196 faz o gatilho pular essas linhas. O eco, ao contrário, EMITE
 * (`message.sent` nasce `done`, sem consumidor): é fato recente e verdadeiro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { findContactByVariants, resolverContatoMeta, sessionByPhoneNumberId } from "./ingest";
import type {
  ContactSyncEvent,
  EchoEvent,
  HistoricoMensagem,
  HistoryChunkEvent,
  HistoryDeclinedEvent,
} from "./coexistence-webhook";

type Admin = SupabaseClient;

import { ORIGEM_HISTORICO, reabrirConversaImportada } from "./conversa-importada";

// Reexportada: é a marca que a migration 0196 (mensagens) e a 0197 (conversas) leem.
export { ORIGEM_HISTORICO };

/**
 * Contato do eco/histórico/agenda. Nome SEMPRE `null`: no eco e no histórico o nome que
 * a Meta traz é o do dono do número, e o `coalesce` do upsert o congelaria no contato do
 * cliente. Telefone, BSUID ou os dois — `resolverContatoMeta` decide.
 */
async function resolverContato(
  admin: Admin,
  orgId: string,
  quem: { phone?: string | null; bsuid?: string | null },
): Promise<string | null> {
  const r = await resolverContatoMeta(admin, orgId, { ...quem, nome: null });
  return "id" in r ? r.id : null;
}

async function resolverConversa(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
  /** Histórico cria a conversa FECHADA e marcada (migration 0197); o eco usa a comum. */
  historica = false,
): Promise<string | null> {
  const { data, error } = await admin.rpc(
    (historica ? "fn_upsert_wa_conversation_historica" : "fn_upsert_wa_conversation") as never,
    { p_org: orgId, p_contact: contactId, p_session: sessionId } as never,
  );
  if (error || !data) return null;
  return data as unknown as string;
}

export type EcoOutcome =
  | { status: "ingested"; messageId: string }
  | { status: "duplicate" }
  | { status: "no_session" }
  | { status: "failed"; reason: string };

function previewDoEco(e: EchoEvent): string {
  if (e.type === "text") return (e.text ?? "").slice(0, 120);
  if (e.type === "audio") return "🎵 Áudio";
  if (e.type === "image") return "📷 Imagem";
  if (e.type === "video") return "🎬 Vídeo";
  if (e.type === "document") return "📎 Documento";
  return `[${e.type}]`;
}

/**
 * Eco = o dono digitou no celular. Vira SAÍDA `external_device` — o mesmo rótulo que
 * o canal por QR já usa, e que as métricas e a detecção de "humano assumiu" leem.
 *
 * Duplicata (23505) é o caso normal de mensagem que o próprio CRM mandou e a Meta
 * ecoou de volta com o mesmo `wamid`; não é erro.
 */
export async function ingestEcho(admin: Admin, e: EchoEvent): Promise<EcoOutcome> {
  const sessao = await sessionByPhoneNumberId(admin, e.phoneNumberId);
  if (!sessao) return { status: "no_session" };
  const orgId = sessao.organization_id;

  const contactId = await resolverContato(admin, orgId, { phone: e.to, bsuid: e.toUserId });
  if (!contactId) return { status: "failed", reason: "contato" };
  const conversationId = await resolverConversa(admin, orgId, contactId, sessao.id);
  if (!conversationId) return { status: "failed", reason: "conversa" };

  const { data: inserida, error } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId,
      channel_session_id: sessao.id,
      contact_id: contactId,
      direction: "outbound",
      status: "sent",
      type: e.type,
      body: e.text,
      external_id: e.externalId,
      media_url: e.media?.id ?? null,
      media_mime: e.media?.mime ?? null,
      sent_via: "external_device",
      sent_at: e.sentAt.toISOString(),
      metadata: e.media
        ? { meta_media_id: e.media.id, eco_do_celular: true }
        : { eco_do_celular: true },
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${error.message}` };
  }

  // A clínica respondeu pelo celular numa conversa que veio do histórico: ela está
  // ativa de novo. Reabre ANTES de carimbar, para o carimbo cair numa conversa aberta.
  await reabrirConversaImportada(admin, conversationId);

  // Direção `outbound`: move `last_outbound_at` e NÃO toca `last_inbound_at` — é o que
  // impede o eco de renovar a janela de 24h do cliente.
  await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId,
    p_direction: "outbound",
    p_preview: previewDoEco(e),
    p_at: e.sentAt.toISOString(),
  } as never);

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (messageId && e.media) {
    await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: conversationId },
      p_metadata: { source: "meta_cloud_webhook" },
      p_organization_id: orgId,
    } as never);
  }
  return { status: "ingested", messageId };
}

/**
 * Agenda do app: só ENRIQUECE o nome de quem já é contato do CRM (e só se estiver
 * sem nome). Criar contato por entrada de agenda traria a lista pessoal do dono
 * para dentro de listas de campanha — e `remove` nunca apaga: o CRM não obedece à
 * agenda do celular para destruir cadastro.
 */
export async function ingestContactSync(
  admin: Admin,
  e: ContactSyncEvent,
): Promise<"enriched" | "skipped" | "no_session"> {
  if (e.action !== "add" || !e.fullName) return "skipped";
  const sessao = await sessionByPhoneNumberId(admin, e.phoneNumberId);
  if (!sessao) return "no_session";
  const contato = await findContactByVariants(admin, sessao.organization_id, e.phone);
  if (!contato) return "skipped";
  const { error } = await admin
    .from("contacts")
    .update({ name: e.fullName })
    .eq("id", contato.id)
    .eq("organization_id", sessao.organization_id)
    .is("name", null);
  return error ? "skipped" : "enriched";
}

function statusDoHistorico(m: HistoricoMensagem): string {
  if (m.inbound) return "delivered";
  switch (m.status) {
    // ERROR no histórico é um fato antigo do app do celular. Gravá-lo como `failed`
    // faria mensagens de meses atrás contarem como falhas recentes no painel de saúde
    // (que mede por `created_at`, e a linha nasce agora). O original fica em metadata.
    case "ERROR":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    default:
      return "sent";
  }
}

/**
 * Mídia do histórico NÃO é baixada: a Meta só manda o conteúdo (num webhook à parte)
 * das últimas 14 dias, e pedir milhares de downloads de uma vez é o jeito de derrubar
 * o worker de mídia. A mensagem entra como texto com marcador honesto.
 */
function linhaDoHistorico(
  m: HistoricoMensagem,
  base: {
    orgId: string;
    conversationId: string;
    sessionId: string;
    contactId: string;
    phase: number | null;
  },
) {
  return {
    organization_id: base.orgId,
    conversation_id: base.conversationId,
    channel_session_id: base.sessionId,
    contact_id: base.contactId,
    direction: m.inbound ? "inbound" : "outbound",
    status: statusDoHistorico(m),
    type: "text",
    body: m.text ?? `[${m.type === "text" ? "mensagem" : "mídia"} anterior à conexão — não disponível]`,
    external_id: m.externalId,
    sent_via: "external_device",
    sent_at: m.sentAt.toISOString(),
    metadata: {
      origem: ORIGEM_HISTORICO,
      tipo_original: m.type,
      fase: base.phase,
      ...(m.status === "ERROR" ? { status_original: "ERROR" } : {}),
    },
  };
}

export type HistoricoOutcome =
  | { status: "imported"; inserted: number; skipped: number; threads: number }
  | { status: "no_session" };

const LOTE = 400;

/**
 * Um bloco do histórico. Idempotente: a Meta pode reentregar (e a documentação não
 * diz como evitar duplicata), então o que já existe por `external_id` é pulado.
 */
export async function ingestHistoryChunk(
  admin: Admin,
  e: HistoryChunkEvent,
): Promise<HistoricoOutcome> {
  const sessao = await sessionByPhoneNumberId(admin, e.phoneNumberId);
  if (!sessao) return { status: "no_session" };
  const orgId = sessao.organization_id;

  let inserted = 0;
  let skipped = 0;
  let threads = 0;

  for (const t of e.threads) {
    const contactId = await resolverContato(admin, orgId, {
      phone: t.contactPhone,
      bsuid: t.contactUserId,
    });
    if (!contactId) {
      skipped += t.messages.length;
      continue;
    }
    const conversationId = await resolverConversa(admin, orgId, contactId, sessao.id, true);
    if (!conversationId) {
      skipped += t.messages.length;
      continue;
    }
    threads += 1;

    const ids = t.messages.map((m) => m.externalId);
    const { data: jaExistem } = await admin
      .from("messages")
      .select("external_id")
      .eq("organization_id", orgId)
      .in("external_id", ids);
    const ja = new Set((jaExistem ?? []).map((r: { external_id: string }) => r.external_id));
    const novas = t.messages.filter((m) => !ja.has(m.externalId));
    skipped += t.messages.length - novas.length;

    const base = { orgId, conversationId, sessionId: sessao.id, contactId, phase: e.phase };
    for (let i = 0; i < novas.length; i += LOTE) {
      const lote = novas.slice(i, i + LOTE).map((m) => linhaDoHistorico(m, base));
      const { error } = await admin.from("messages").insert(lote);
      if (!error) {
        inserted += lote.length;
        continue;
      }
      // Corrida com uma reentrega: o lote inteiro cai em 23505. Linha a linha.
      if (error.code === "23505") {
        for (const linha of lote) {
          const { error: e1 } = await admin.from("messages").insert(linha);
          if (!e1) inserted += 1;
          else skipped += 1;
        }
      } else {
        logger.warn("[meta.history] lote não gravado", { detail: error.message });
        skipped += lote.length;
      }
    }

    // Carimba só o que é SEGURO: a "última mensagem" da lista, se for mais nova.
    const maisNova = t.messages.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
    const previa = (maisNova.text ?? "[mídia]").slice(0, 120);
    await admin
      .from("conversations")
      .update({ last_message_at: maisNova.sentAt.toISOString(), last_message_preview: previa })
      .eq("id", conversationId)
      .eq("organization_id", orgId)
      .or(`last_message_at.is.null,last_message_at.lt.${maisNova.sentAt.toISOString()}`);
  }

  return { status: "imported", inserted, skipped, threads };
}

/**
 * Recusa de histórico (2593109): o cliente escolheu não compartilhar. Não é falha —
 * a conexão segue válida, só não há passado a importar.
 *
 * Só LOG, e não `emit_event`: evento sem consumidor nasce `pending` e fica para
 * sempre no índice que o drain escaneia (issue #129, migration 0183). Quando a tela
 * precisar mostrar isto, o caminho é uma coluna na sessão, não um evento órfão.
 */
export async function registrarHistoricoRecusado(
  admin: Admin,
  e: HistoryDeclinedEvent,
): Promise<void> {
  const sessao = await sessionByPhoneNumberId(admin, e.phoneNumberId);
  if (!sessao) return;
  logger.info("[meta.history] cliente recusou compartilhar o histórico", {
    organization_id: sessao.organization_id,
    channel_session_id: sessao.id,
    code: e.code,
  });
}
