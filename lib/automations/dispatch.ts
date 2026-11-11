/**
 * Um TICK do despachante de automações — chamado pelo cron
 * `api/v1/cron/template-automations-dispatch` a cada minuto. Espelha
 * `lib/campaigns/dispatch.ts` (mesmo throttle, mesmo caminho de envio),
 * mas varre `whatsapp_template_automations` (`status='active'`, roda pra
 * sempre) em vez de uma campanha com público materializado que termina.
 *
 * O QUEM está devido é decidido pelo `trigger_kind` da automação
 * (`lib/automations/triggers/`) — este arquivo não sabe o que cada
 * gatilho verifica, só despacha quem ele devolveu.
 *
 * Três garantias (2026-11-10, confirmação de Laser da B'Laser Parnamirim):
 *
 *   1. RESERVA antes de enviar. A linha em `whatsapp_template_automation_sends`
 *      nasce `sending` ANTES da chamada à Meta, e a chave única
 *      (automation_id, occurrence_key) decide quem envia: dois ticks que se
 *      sobrepõem resultam em UM envio (o segundo recebe 23505 e pula). É o que
 *      deixa o cron rodar a cada minuto — com 15 min e ~10 envios por tick, 80
 *      pacientes levavam 10 horas para receber a confirmação.
 *   2. Reserva abandonada (processo morreu entre reservar e gravar o desfecho)
 *      vira `failed` depois de `RESERVA_ABANDONADA_MIN` — NÃO é reenviada:
 *      envio em dobro é pior que não-envio.
 *   3. Consulta de quem está devido que FALHA abre aviso crítico na Central, e o
 *      primeiro tick que funciona o fecha (`aviso-de-falha.ts`). Antes, a falha
 *      ia só para o log e a clínica ficava o dia sem confirmação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation } from "@/lib/automation/start-conversation";
import { CAMPAIGN_SEND_SPACING_MS, checkDailyLimit, withinSendWindow } from "@/lib/automation/throttle";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { logger } from "@/lib/logger";
import { motivoDaFalha } from "@/lib/messaging/motivo-da-falha";
import { renderBodyWithValues } from "@/lib/messaging/render-body";
import { resolveValuesForRecipient, type VariableMapping } from "@/lib/messaging/variable-mapping";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { abrirAvisoDeFalha, fecharAvisoDeFalha } from "./aviso-de-falha";
import { RESERVA_ABANDONADA_MIN, type EstadoDoEnvio } from "./estados-do-envio";
import { TRIGGER_RESOLVERS, type OcorrenciaDevida } from "./triggers";

/** Deixa margem sob o timeout do cron (60s, `docker/scheduler/entrypoint.sh`). */
const DEFAULT_TIME_BUDGET_MS = 50_000;

/** Violação de chave única do Postgres — aqui, "outro tick já reservou esta ocorrência". */
const JA_RESERVADA = "23505";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DispatchDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  ensureConversationFn?: typeof ensureConversation;
  sendMessageFn?: typeof sendMessageHandler;
  timeBudgetMs?: number;
}

export interface AutomationDispatchSummary {
  automationsProcessed: number;
  sent: number;
  failed: number;
  /** Ocorrências que outro tick já tinha reservado — puladas, sem envio. */
  skippedReserved: number;
  /** Automações cuja consulta de devidos falhou neste tick (cada uma abre/mantém aviso). */
  resolveFailed: number;
}

interface AutomacaoRow {
  id: string;
  organization_id: string;
  name: string;
  trigger_kind: string;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
}

/**
 * Grava o desfecho na linha reservada. Se a gravação falhar, a reserva fica
 * `sending` e o fechamento de abandonadas a encerra — a ocorrência continua sem
 * reenvio, que é o que importa.
 */
async function gravarDesfecho(
  admin: SupabaseClient,
  reservaId: string,
  desfecho: { status: EstadoDoEnvio; external_id?: string | null; error_message?: string | null },
): Promise<void> {
  const { error } = await admin
    .from("whatsapp_template_automation_sends")
    .update({ ...desfecho, sent_at: new Date().toISOString() })
    .eq("id", reservaId);
  if (error) {
    logger.error("[automations/dispatch] desfecho não gravado — a reserva fica sending", {
      reserva_id: reservaId,
      error: error.message,
    });
  }
}

/** `true` se enviou (ou tentou); `false` se a ocorrência já era de outro tick. */
async function processarOcorrencia(
  admin: SupabaseClient,
  automacao: AutomacaoRow,
  rawBody: string,
  ocorrencia: OcorrenciaDevida,
  deps: Required<Pick<DispatchDeps, "ensureConversationFn" | "sendMessageFn">>,
  resumo: AutomationDispatchSummary,
): Promise<boolean> {
  const { data: reserva, error: erroDaReserva } = await admin
    .from("whatsapp_template_automation_sends")
    .insert({
      automation_id: automacao.id,
      organization_id: automacao.organization_id,
      lead_id: ocorrencia.leadId,
      contact_id: ocorrencia.contactId,
      occurrence_key: ocorrencia.occurrenceKey,
      appointment_id: ocorrencia.appointmentId ?? null,
      status: "sending" satisfies EstadoDoEnvio,
    })
    .select("id")
    .single();

  if (erroDaReserva || !reserva) {
    if (erroDaReserva?.code === JA_RESERVADA) {
      resumo.skippedReserved += 1;
    } else {
      // Sem reserva não há envio: mandar sem a linha seria mandar sem a trava.
      logger.error("[automations/dispatch] reserva falhou — ocorrência fica para o próximo tick", {
        automation_id: automacao.id,
        occurrence_key: ocorrencia.occurrenceKey,
        error: erroDaReserva?.message ?? "sem linha",
      });
    }
    return false;
  }
  const reservaId = (reserva as { id: string }).id;

  const resolvedValues = resolveValuesForRecipient(automacao.variable_mapping, {
    displayName: ocorrencia.displayName,
    appointmentAt: ocorrencia.appointmentAt,
  });

  try {
    const conversationId = await deps.ensureConversationFn(
      admin,
      automacao.organization_id,
      ocorrencia.contactId,
      automacao.channel_session_id,
    );
    const message = await deps.sendMessageFn(
      admin,
      {
        organization_id: automacao.organization_id,
        actor: { type: "webhook_source", id: automacao.id },
        requestId: `automation:${automacao.id}:${ocorrencia.occurrenceKey}`,
      },
      {
        conversation_id: conversationId,
        type: "template",
        template_name: automacao.template_name,
        template_language: automacao.template_language,
        template_values: resolvedValues,
        body: renderBodyWithValues(rawBody, resolvedValues),
      },
    );

    if (message.status === "sent") {
      await gravarDesfecho(admin, reservaId, { status: "sent", external_id: message.external_id });
      resumo.sent += 1;
    } else {
      await gravarDesfecho(admin, reservaId, { status: "failed", error_message: motivoDaFalha(message) });
      resumo.failed += 1;
    }
  } catch (err) {
    await gravarDesfecho(admin, reservaId, {
      status: "failed",
      error_message: err instanceof Error ? err.message.slice(0, 500) : "erro desconhecido",
    });
    resumo.failed += 1;
  }
  return true;
}

async function processarAutomacao(
  admin: SupabaseClient,
  automacao: AutomacaoRow,
  now: Date,
  deadline: number,
  deps: Required<Pick<DispatchDeps, "sleep" | "ensureConversationFn" | "sendMessageFn">>,
  resumo: AutomationDispatchSummary,
): Promise<void> {
  const resolver = TRIGGER_RESOLVERS[automacao.trigger_kind];
  // `trigger_kind` desconhecido (ex.: dado corrompido, ou uma automação
  // criada por uma versão futura do produto e este servidor ainda não
  // tem o resolver) — pula em silêncio de log, nunca derruba o tick
  // inteiro por causa de UMA automação.
  if (!resolver) return;

  let ocorrencias: OcorrenciaDevida[];
  try {
    ocorrencias = await resolver.resolve(admin, { id: automacao.id, organizationId: automacao.organization_id }, now);
  } catch (err) {
    // Uma automação quebrada não derruba as outras do tick — mas também não
    // passa calada: a Central recebe o aviso (uma vez, enquanto durar).
    resumo.resolveFailed += 1;
    await abrirAvisoDeFalha(admin, automacao, err instanceof Error ? err.message : String(err));
    return;
  }
  await fecharAvisoDeFalha(admin, automacao);
  if (ocorrencias.length === 0) return;

  const { data: templateRow } = await admin
    .from("meta_templates")
    .select("components")
    .eq("organization_id", automacao.organization_id)
    .eq("channel_session_id", automacao.channel_session_id)
    .eq("name", automacao.template_name)
    .eq("language", automacao.template_language)
    .maybeSingle();
  const rawBody =
    lerConteudo((templateRow as { components?: unknown } | null)?.components ?? []).body ??
    automacao.template_name;

  resumo.automationsProcessed += 1;

  for (const ocorrencia of ocorrencias) {
    if (Date.now() >= deadline) break;
    const enviou = await processarOcorrencia(admin, automacao, rawBody, ocorrencia, deps, resumo);
    if (Date.now() >= deadline) break;
    // Só espaça depois de um envio de verdade: pular uma ocorrência já reservada
    // não chega à Meta e não precisa da pausa anti-banimento.
    if (enviou) await deps.sleep(CAMPAIGN_SEND_SPACING_MS);
  }
}

/**
 * Reserva `sending` mais velha que `RESERVA_ABANDONADA_MIN`: o tick que a fez
 * morreu entre reservar e gravar o desfecho. Não sabemos se a Meta recebeu — por
 * isso `failed` e não um novo envio.
 */
async function fecharReservasAbandonadas(admin: SupabaseClient): Promise<void> {
  const limite = new Date(Date.now() - RESERVA_ABANDONADA_MIN * 60_000).toISOString();
  const { error } = await admin
    .from("whatsapp_template_automation_sends")
    .update({
      status: "failed" satisfies EstadoDoEnvio,
      error_message: "Envio interrompido no meio; não reenviado para evitar mensagem em dobro.",
    })
    .eq("status", "sending")
    .lt("sent_at", limite);
  if (error) {
    logger.error("[automations/dispatch] não fechou as reservas abandonadas", { error: error.message });
  }
}

export async function dispatchAutomationsTick(
  admin: SupabaseClient,
  deps: DispatchDeps = {},
): Promise<AutomationDispatchSummary> {
  const now = deps.now ?? (() => new Date());
  const instanteAtual = now();
  const deadline = Date.now() + (deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const resolvedDeps = {
    sleep: deps.sleep ?? sleep,
    ensureConversationFn: deps.ensureConversationFn ?? ensureConversation,
    sendMessageFn: deps.sendMessageFn ?? sendMessageHandler,
  };

  const resumo: AutomationDispatchSummary = {
    automationsProcessed: 0,
    sent: 0,
    failed: 0,
    skippedReserved: 0,
    resolveFailed: 0,
  };

  await fecharReservasAbandonadas(admin);

  if (!withinSendWindow(instanteAtual)) return resumo;

  const { data: automacoes } = await admin
    .from("whatsapp_template_automations")
    .select("id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language, variable_mapping")
    .eq("status", "active")
    // Excluída (0222) nunca envia — a rota já a deixa pausada; isto é o cinto além do suspensório.
    .is("archived_at", null);

  for (const automacao of (automacoes ?? []) as AutomacaoRow[]) {
    if (Date.now() > deadline) break;

    const daily = await checkDailyLimit(admin, automacao.organization_id, automacao.channel_session_id);
    if (!daily.allowed) continue;

    await processarAutomacao(admin, automacao, instanteAtual, deadline, resolvedDeps, resumo);
  }

  return resumo;
}
