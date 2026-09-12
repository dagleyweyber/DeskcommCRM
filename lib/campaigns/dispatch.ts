/**
 * Um TICK do despachante de campanhas — chamado pelo cron
 * `api/v1/cron/campaign-dispatch` a cada minuto. Processa um lote pequeno
 * por campanha `queued`/`running`, respeitando janela de horário, limite
 * diário e `CAMPAIGN_SEND_SPACING_MS` — TUDO reaproveitado de
 * `lib/automation/throttle.ts`, nada novo em anti-banimento.
 *
 * Nenhum código aqui fala com a Graph API: `ensureConversation` +
 * `sendMessageHandler` são o MESMO caminho que `JanelaFechadaAviso.tsx` usa
 * pro envio manual de um template só. As duas funções entram por parâmetro
 * (`DispatchDeps`) pra o teste poder trocá-las por dublê sem bater na Meta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation } from "@/lib/automation/start-conversation";
import { CAMPAIGN_SEND_SPACING_MS, checkDailyLimit, withinSendWindow } from "@/lib/automation/throttle";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { renderBodyWithValues } from "@/lib/messaging/render-body";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

/** Deixa margem sob o timeout do cron (25s, `docker/scheduler/entrypoint.sh`). */
const DEFAULT_TIME_BUDGET_MS = 20_000;

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

export interface DispatchSummary {
  campaignsProcessed: number;
  sent: number;
  failed: number;
}

interface CampanhaRow {
  id: string;
  organization_id: string;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  status: string;
}

interface DestinatarioRow {
  id: string;
  contact_id: string;
  resolved_values: Record<string, string>;
}

/**
 * Recontagem por LEITURA das linhas, não incremento — a mesma proteção que
 * `planSync` já usa noutro lugar: uma única instância de cron por vez
 * (mesma premissa que `_lastSendAt` em `send-whatsapp.ts` já assume), então
 * não há corrida a resolver, só simplicidade a ganhar.
 */
async function atualizarContadores(admin: SupabaseClient, campaignId: string): Promise<void> {
  const { data } = await admin
    .from("whatsapp_campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);
  const linhas = (data ?? []) as Array<{ status: string }>;
  const sentCount = linhas.filter((l) => l.status === "sent").length;
  const failedCount = linhas.filter((l) => l.status === "failed").length;
  const restaAlgo = linhas.some((l) => l.status === "pending" || l.status === "sending");

  await admin
    .from("whatsapp_campaigns")
    .update({
      sent_count: sentCount,
      failed_count: failedCount,
      ...(restaAlgo ? {} : { status: "completed", completed_at: new Date().toISOString() }),
    })
    .eq("id", campaignId);
}

async function processarCampanha(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  deadline: number,
  deps: Required<Pick<DispatchDeps, "sleep" | "ensureConversationFn" | "sendMessageFn">>,
  resumo: DispatchSummary,
): Promise<void> {
  const { data: templateRow } = await admin
    .from("meta_templates")
    .select("components")
    .eq("organization_id", campanha.organization_id)
    .eq("channel_session_id", campanha.channel_session_id)
    .eq("name", campanha.template_name)
    .eq("language", campanha.template_language)
    .maybeSingle();
  const rawBody =
    lerConteudo((templateRow as { components?: unknown } | null)?.components ?? []).body ??
    campanha.template_name;

  while (Date.now() < deadline) {
    const { data: pendentes } = await admin
      .from("whatsapp_campaign_recipients")
      .select("id, contact_id, resolved_values")
      .eq("campaign_id", campanha.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);
    const alvo = ((pendentes ?? []) as DestinatarioRow[])[0];
    if (!alvo) break;

    await admin
      .from("whatsapp_campaign_recipients")
      .update({ status: "sending" })
      .eq("id", alvo.id);

    try {
      const conversationId = await deps.ensureConversationFn(
        admin,
        campanha.organization_id,
        alvo.contact_id,
        campanha.channel_session_id,
      );
      const message = await deps.sendMessageFn(
        admin,
        {
          organization_id: campanha.organization_id,
          actor: { type: "webhook_source", id: campanha.id },
          requestId: `campaign:${campanha.id}`,
        },
        {
          conversation_id: conversationId,
          type: "template",
          template_name: campanha.template_name,
          template_language: campanha.template_language,
          template_values: alvo.resolved_values,
          body: renderBodyWithValues(rawBody, alvo.resolved_values),
        },
      );

      if (message.status === "sent") {
        await admin
          .from("whatsapp_campaign_recipients")
          .update({ status: "sent", external_id: message.external_id, sent_at: new Date().toISOString() })
          .eq("id", alvo.id);
        resumo.sent += 1;
      } else {
        // `queued`/`failed` — o canal pode ter caído entre a criação da
        // campanha e este tick. Tratado como falha desta tentativa; o
        // operador vê o motivo na lista de destinatários.
        await admin
          .from("whatsapp_campaign_recipients")
          .update({
            status: "failed",
            error_message: `mensagem ficou em '${message.status}' — canal indisponível no momento do envio`,
          })
          .eq("id", alvo.id);
        resumo.failed += 1;
      }
    } catch (err) {
      await admin
        .from("whatsapp_campaign_recipients")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message.slice(0, 500) : "erro desconhecido",
        })
        .eq("id", alvo.id);
      resumo.failed += 1;
    }

    if (Date.now() >= deadline) break;
    await deps.sleep(CAMPAIGN_SEND_SPACING_MS);
  }

  await atualizarContadores(admin, campanha.id);
}

export async function dispatchCampaignsTick(
  admin: SupabaseClient,
  deps: DispatchDeps = {},
): Promise<DispatchSummary> {
  const now = deps.now ?? (() => new Date());
  const deadline = Date.now() + (deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const resolvedDeps = {
    sleep: deps.sleep ?? sleep,
    ensureConversationFn: deps.ensureConversationFn ?? ensureConversation,
    sendMessageFn: deps.sendMessageFn ?? sendMessageHandler,
  };

  const resumo: DispatchSummary = { campaignsProcessed: 0, sent: 0, failed: 0 };

  const { data: campanhas } = await admin
    .from("whatsapp_campaigns")
    .select("id, organization_id, channel_session_id, template_name, template_language, status")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true });

  for (const campanha of (campanhas ?? []) as CampanhaRow[]) {
    if (Date.now() > deadline) break;

    if (campanha.status === "queued") {
      await admin.from("whatsapp_campaigns").update({ status: "running" }).eq("id", campanha.id);
    }

    if (!withinSendWindow(now())) continue;
    const daily = await checkDailyLimit(admin, campanha.organization_id, campanha.channel_session_id);
    if (!daily.allowed) continue;

    resumo.campaignsProcessed += 1;
    await processarCampanha(admin, campanha, deadline, resolvedDeps, resumo);
  }

  return resumo;
}
