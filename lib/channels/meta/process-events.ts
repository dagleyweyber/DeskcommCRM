/**
 * O processamento dos eventos de UMA sessão Meta — compartilhado pelos dois
 * endereços de webhook.
 *
 * - `/api/v1/webhooks/meta/[token]`: o endereço da sessão (`override_callback_uri`),
 *   onde chegam mensagens, ecos, histórico e agenda.
 * - `/api/v1/webhooks/meta`: o endereço padrão do app, onde a Meta entrega o que não
 *   admite override (`account_update`, status de modelo) e que acha a sessão pela WABA.
 *
 * O laço mora aqui, e não duplicado em cada rota, porque uma regra escrita duas vezes
 * diverge: a de ignorar evento de outra WABA, a de exigir o número da sessão e a de
 * nunca acionar a IA no eco/histórico existem uma só vez.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sincronizarSaudeDaConexao } from "../health";
import { registrarAviso } from "../zernio/avisos";
import { avisoDoAccountUpdate, detalheDaDesconexao, saudeDoAccountUpdate } from "./account-update";
import type { AccountUpdateEvent } from "./coexistence-webhook";
import {
  ingestContactSync,
  ingestEcho,
  ingestHistoryChunk,
  ingestHistoryMedia,
  registrarHistoricoRecusado,
} from "./coexistence-ingest";
import { ingestMetaInbound } from "./ingest";
import type { MetaWebhookSession } from "./session";
import type { MetaWebhookEvent } from "./webhook";

type Admin = SupabaseClient;

/**
 * Aplica um `account_update` à sessão: saúde (queda/volta) e/ou aviso avulso.
 *
 * Queda e volta passam por `sincronizarSaudeDaConexao` com origem "empurrao" — a
 * Meta é a autoridade sobre o estado do número, então a varredura periódica (que só
 * mede credencial) não fecha o que ela abriu. O `channel_sessions.status` também é
 * gravado: é dele que a faixa vermelha do topo lê.
 */
export async function tratarAccountUpdate(
  admin: Admin,
  session: MetaWebhookSession,
  e: AccountUpdateEvent,
): Promise<string> {
  const saude = saudeDoAccountUpdate(e);
  if (saude) {
    const { data: s } = await admin
      .from("channel_sessions")
      .select("id, organization_id, display_name, phone_number")
      .eq("id", session.id)
      .eq("organization_id", session.organizationId)
      .maybeSingle();
    if (!s) return "sessao_nao_encontrada";

    if (saude.status) {
      await admin
        .from("channel_sessions")
        .update({ status: saude.status })
        .eq("id", session.id)
        .eq("organization_id", session.organizationId);
    }

    const apelido = (s.display_name as string | null) ?? (s.phone_number as string | null) ?? "sem nome";
    const desfecho = await sincronizarSaudeDaConexao(
      admin,
      { id: session.id, organization_id: session.organizationId, status: saude.status },
      saude,
      apelido,
      "empurrao",
    );

    // O aviso genérico da conexão não diz POR QUE caiu. Em coexistência o motivo é a
    // informação útil (celular parado 14 dias, número trocado): acrescenta ao aviso que
    // acabou de abrir, para a clínica saber o que fazer.
    const motivo = detalheDaDesconexao(e);
    if (desfecho === "avisado" && motivo) {
      const { data: item } = await admin
        .from("agent_inbox_items")
        .select("id, body")
        .eq("organization_id", session.organizationId)
        .eq("ref_kind", "channel_session")
        .eq("ref_id", session.id)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (item) {
        await admin
          .from("agent_inbox_items")
          .update({ body: [item.body, motivo].filter(Boolean).join(" ") })
          .eq("id", item.id as string)
          .eq("organization_id", session.organizationId);
      }
    }
    return desfecho;
  }

  const aviso = avisoDoAccountUpdate(e);
  if (aviso) return registrarAviso(admin, session.organizationId, aviso);
  return "ignorado";
}

/**
 * Processa os eventos já parseados e devolve o desfecho de cada um.
 *
 * O desfecho existe porque a primeira versão descartava o retorno da ingestão: um
 * insert que falhava virava `{"received": 1}` com nada gravado, e "chegou e falhou"
 * ficava indistinguível de "não chegou".
 */
export async function processarEventosMeta(input: {
  admin: Admin;
  session: MetaWebhookSession;
  eventos: MetaWebhookEvent[];
  requestId: string;
}): Promise<string[]> {
  const { admin, session, eventos, requestId } = input;
  const now = new Date().toISOString();
  const desfechos: string[] = [];

  for (const e of eventos) {
    // O evento chega carimbado com a WABA; se não for a desta sessão, ignoramos.
    // Confiar no `entry.id` para escolher a org seria aceitar o corpo como fonte.
    if (session.wabaId && e.wabaId && e.wabaId !== session.wabaId) continue;

    if (e.kind === "inbound_message") {
      // A metade que faltava: mensagem do contato vira linha no inbox, move lead,
      // acorda o agente — e carimba `last_inbound_at`, que é o que ABRE a janela
      // de 24h que o gate da Fase 4 calcula.
      const r = await ingestMetaInbound(admin, e, requestId);
      desfechos.push(r.status);
      if (r.status === "failed" || r.status === "no_session") {
        // 2xx continua (a Meta re-entregaria em loop), mas a falha NÃO fica muda:
        // vai ao log estruturado e ao corpo da resposta.
        console.error("[meta.ingest] inbound não ingerido", {
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          external_id: e.externalId,
          phone_number_id: e.phoneNumberId,
        });
      }
      continue;
    }

    // Os eventos da coexistência resolvem a sessão pelo NÚMERO do corpo (como o
    // inbound). Aqui exigimos que seja o número DESTA sessão: o token do caminho é o
    // que amarra o payload a uma organização, e o corpo não pode escolher outra.
    if (
      (e.kind === "echo" ||
        e.kind === "history_chunk" ||
        e.kind === "history_media" ||
        e.kind === "history_declined" ||
        e.kind === "contact_sync") &&
      session.phoneNumberId &&
      e.phoneNumberId !== session.phoneNumberId
    ) {
      desfechos.push(`${e.kind}:numero_de_outra_sessao`);
      continue;
    }

    // ── Coexistência (o app do celular). Nada aqui passa por `pos-entrada`: eco,
    // histórico e agenda NÃO acordam o agente nem criam lead — ver
    // `lib/channels/meta/coexistence-ingest.ts`.
    if (e.kind === "echo") {
      const r = await ingestEcho(admin, e);
      desfechos.push(`echo:${r.status}`);
      if (r.status === "failed") {
        console.error("[meta.echo] eco não ingerido", { reason: r.reason, external_id: e.externalId });
      }
      continue;
    }
    if (e.kind === "history_chunk") {
      const r = await ingestHistoryChunk(admin, e);
      desfechos.push(
        r.status === "imported" ? `history:${r.inserted}+${r.skipped}` : `history:${r.status}`,
      );
      continue;
    }
    if (e.kind === "history_media") {
      desfechos.push(`history_media:${await ingestHistoryMedia(admin, e)}`);
      continue;
    }
    if (e.kind === "history_declined") {
      await registrarHistoricoRecusado(admin, e);
      desfechos.push("history:declined");
      continue;
    }
    if (e.kind === "contact_sync") {
      desfechos.push(`contact_sync:${await ingestContactSync(admin, e)}`);
      continue;
    }

    // ── Avisos da CONTA (desconexão, banimento, restrição, volta). Chegam ao endereço
    // padrão do app — ver `app/api/v1/webhooks/meta/route.ts` — mas o tratamento é
    // este, para o endereço por canal reaproveitar se um dia receber um.
    if (e.kind === "account_update") {
      desfechos.push(`account_update:${e.event}:${await tratarAccountUpdate(admin, session, e)}`);
      continue;
    }

    if (e.kind === "template_status") {
      await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: now })
        .eq("organization_id", session.organizationId)
        .eq("waba_id", e.wabaId)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
    } else if (e.kind === "message_status") {
      // Achado ao vivo (RevitaFio Mossoró): campanha com TODO envio "failed"
      // e nenhum jeito de saber por quê — o `errorCode`/`errorTitle` que a
      // Meta manda no próprio webhook de status era descartado aqui, e
      // `messages.metadata` ficava `{}` pra sempre. Falha de entrega
      // (assíncrona, depois de um `wamid` válido) é diferente de recusa na
      // submissão (síncrona, já tratada em `template-ops.ts`) — as duas
      // precisam do motivo real, cada uma na sua camada.
      const detalheErro =
        e.status === "failed"
          ? Array.from(
              new Set([e.errorTitle, e.errorMessage, e.errorDetails].filter(
                (p): p is string => Boolean(p && p.trim()),
              )),
            ).join(" — ") || null
          : null;

      // Falha com motivo: MESCLA no metadata existente. Substituir apagava as outras
      // chaves da linha (marca do histórico, id da mídia, flag de voz).
      let metadataMesclado: Record<string, unknown> | null = null;
      if (detalheErro) {
        const { data: atual } = await admin
          .from("messages")
          .select("metadata")
          .eq("organization_id", session.organizationId)
          .eq("external_id", e.externalId)
          .maybeSingle();
        metadataMesclado = {
          ...((atual?.metadata as Record<string, unknown> | null) ?? {}),
          failure_code: e.errorCode,
          failure_reason: detalheErro,
        };
      }
      await admin
        .from("messages")
        .update({
          status: e.status === "failed" ? "failed" : "sent",
          updated_at: now,
          ...(metadataMesclado ? { metadata: metadataMesclado } : {}),
        })
        .eq("organization_id", session.organizationId)
        .eq("external_id", e.externalId);
    }
  }

  return desfechos;
}
