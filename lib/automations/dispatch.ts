/**
 * Um TICK do despachante de automações — chamado pelo cron
 * `api/v1/cron/template-automations-dispatch` a cada 15 minutos. Espelha
 * `lib/campaigns/dispatch.ts` (mesmo throttle, mesmo caminho de envio),
 * mas varre `whatsapp_template_automations` (`status='active'`, roda pra
 * sempre) em vez de uma campanha com público materializado que termina.
 *
 * O QUEM está devido é decidido pelo `trigger_kind` da automação
 * (`lib/automations/triggers/`) — este arquivo não sabe o que cada
 * gatilho verifica, só despacha quem ele devolveu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation } from "@/lib/automation/start-conversation";
import { CAMPAIGN_SEND_SPACING_MS, checkDailyLimit, withinSendWindow } from "@/lib/automation/throttle";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { renderBodyWithValues } from "@/lib/messaging/render-body";
import { resolveValuesForRecipient, type VariableMapping } from "@/lib/messaging/variable-mapping";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { TRIGGER_RESOLVERS, type OcorrenciaDevida } from "./triggers";

/** Deixa margem sob o timeout do cron (60s, `docker/scheduler/entrypoint.sh`). */
const DEFAULT_TIME_BUDGET_MS = 50_000;

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
}

interface AutomacaoRow {
  id: string;
  organization_id: string;
  trigger_kind: string;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
}

async function processarOcorrencia(
  admin: SupabaseClient,
  automacao: AutomacaoRow,
  rawBody: string,
  ocorrencia: OcorrenciaDevida,
  deps: Required<Pick<DispatchDeps, "ensureConversationFn" | "sendMessageFn">>,
  resumo: AutomationDispatchSummary,
): Promise<void> {
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
      await admin.from("whatsapp_template_automation_sends").insert({
        automation_id: automacao.id,
        organization_id: automacao.organization_id,
        lead_id: ocorrencia.leadId,
        contact_id: ocorrencia.contactId,
        occurrence_key: ocorrencia.occurrenceKey,
        external_id: message.external_id,
        status: "sent",
      });
      resumo.sent += 1;
    } else {
      await admin.from("whatsapp_template_automation_sends").insert({
        automation_id: automacao.id,
        organization_id: automacao.organization_id,
        lead_id: ocorrencia.leadId,
        contact_id: ocorrencia.contactId,
        occurrence_key: ocorrencia.occurrenceKey,
        status: "failed",
        error_message: `mensagem ficou em '${message.status}' — canal indisponível no momento do envio`,
      });
      resumo.failed += 1;
    }
  } catch (err) {
    await admin.from("whatsapp_template_automation_sends").insert({
      automation_id: automacao.id,
      organization_id: automacao.organization_id,
      lead_id: ocorrencia.leadId,
      contact_id: ocorrencia.contactId,
      occurrence_key: ocorrencia.occurrenceKey,
      status: "failed",
      error_message: err instanceof Error ? err.message.slice(0, 500) : "erro desconhecido",
    });
    resumo.failed += 1;
  }
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

  const ocorrencias = await resolver.resolve(admin, { id: automacao.id, organizationId: automacao.organization_id }, now);
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
    await processarOcorrencia(admin, automacao, rawBody, ocorrencia, deps, resumo);
    if (Date.now() >= deadline) break;
    await deps.sleep(CAMPAIGN_SEND_SPACING_MS);
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

  const resumo: AutomationDispatchSummary = { automationsProcessed: 0, sent: 0, failed: 0 };

  if (!withinSendWindow(instanteAtual)) return resumo;

  const { data: automacoes } = await admin
    .from("whatsapp_template_automations")
    .select("id, organization_id, trigger_kind, channel_session_id, template_name, template_language, variable_mapping")
    .eq("status", "active");

  for (const automacao of (automacoes ?? []) as AutomacaoRow[]) {
    if (Date.now() > deadline) break;

    const daily = await checkDailyLimit(admin, automacao.organization_id, automacao.channel_session_id);
    if (!daily.allowed) continue;

    await processarAutomacao(admin, automacao, instanteAtual, deadline, resolvedDeps, resumo);
  }

  return resumo;
}
