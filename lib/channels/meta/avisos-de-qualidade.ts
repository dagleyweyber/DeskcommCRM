/**
 * Os avisos da Meta que decidem se uma campanha pode seguir: nota do modelo, qualidade do
 * número, alerta e violação da conta, modelo pausado. Cada um faz duas coisas:
 *
 *   1. GRAVA o estado (`meta_templates.quality_score`/`status`, `channel_sessions.meta_quality_*`)
 *      — é dele que o painel lê e que o despachante confere antes de cada rodada;
 *   2. PAUSA na hora as campanhas andando que dependem daquilo (`pausarCampanhasAtivas`), com o
 *      motivo gravado na campanha — sem esperar o próximo minuto do despachante.
 *
 * A sessão chega resolvida pela WABA (`app/api/v1/webhooks/meta/route.ts`), mas uma WABA pode
 * ter mais de um número: o que é da CONTA vale para todas as sessões dela; o que é de um MODELO
 * vale para as sessões que têm aquele modelo; o que é de um NÚMERO, só para ele.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { pausarCampanhasAtivas, type Freio } from "@/lib/campaigns/freios";

import { registrarAviso } from "../zernio/avisos";
import type { AccountUpdateEvent } from "./coexistence-webhook";
import type { MetaWebhookSession } from "./session";
import type { AccountAlertEvent, PhoneQualityEvent, TemplateQualityEvent, TemplateStatusEvent } from "./webhook";

type Admin = SupabaseClient;

const NOTA_EM_PORTUGUES: Record<string, string> = {
  GREEN: "verde",
  YELLOW: "amarela",
  RED: "vermelha",
  UNKNOWN: "sem nota",
};

/** Sessões da organização que pertencem a esta WABA. */
async function sessoesDaConta(admin: Admin, session: MetaWebhookSession, wabaId: string): Promise<string[]> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("meta_waba_id", wabaId)
    .is("archived_at", null);
  const ids = ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
  return ids.length > 0 ? ids : [session.id];
}

/** Nota do modelo mudou: grava, avisa e pausa as campanhas do modelo em amarelo ou vermelho. */
export async function aplicarQualidadeDoModelo(
  admin: Admin,
  session: MetaWebhookSession,
  e: TemplateQualityEvent,
): Promise<string> {
  const { data } = await admin
    .from("meta_templates")
    .update({ quality_score: e.newScore, updated_at: new Date().toISOString() })
    .eq("organization_id", session.organizationId)
    .eq("waba_id", e.wabaId)
    .eq("name", e.templateName)
    .eq("language", e.templateLanguage)
    .select("channel_session_id");
  const sessoes = ((data ?? []) as Array<{ channel_session_id: string | null }>)
    .map((t) => t.channel_session_id)
    .filter((id): id is string => Boolean(id));

  const nota = NOTA_EM_PORTUGUES[e.newScore] ?? e.newScore;
  if (e.newScore !== "YELLOW" && e.newScore !== "RED") return `template_quality:${e.newScore}`;

  await registrarAviso(admin, session.organizationId, {
    kind: "channel_template_review",
    severity: e.newScore === "RED" ? "critical" : "warn",
    title: `Modelo "${e.templateName}": nota ${nota}`,
    body:
      "A Meta mede quantas pessoas bloqueiam ou denunciam a mensagem. Com nota baixa, o modelo pode ser pausado " +
      "e a qualidade do número cai junto. As campanhas que usam este modelo foram pausadas.",
  });

  const freio: Freio = {
    motivo: e.newScore === "RED" ? "modelo_nota_vermelha" : "modelo_nota_amarela",
    detalhe: `A Meta mudou a nota do modelo "${e.templateName}" para ${nota}.`,
  };
  const n = await pausarCampanhasAtivas(
    admin,
    {
      organizationId: session.organizationId,
      channelSessionIds: sessoes,
      templateName: e.templateName,
      templateLanguage: e.templateLanguage,
    },
    freio,
  );
  return `template_quality:${e.newScore}:pausadas=${n}`;
}

/** Modelo pausado, desativado ou reprovado pela Meta: as campanhas dele param na hora. */
export async function pausarPorEstadoDoModelo(
  admin: Admin,
  session: MetaWebhookSession,
  e: TemplateStatusEvent,
): Promise<number> {
  const estado = e.event.toUpperCase();
  if (estado === "APPROVED" || estado === "PENDING" || estado === "IN_APPEAL") return 0;

  const { data } = await admin
    .from("meta_templates")
    .select("channel_session_id")
    .eq("organization_id", session.organizationId)
    .eq("waba_id", e.wabaId)
    .eq("name", e.templateName)
    .eq("language", e.templateLanguage);
  const sessoes = ((data ?? []) as Array<{ channel_session_id: string | null }>)
    .map((t) => t.channel_session_id)
    .filter((id): id is string => Boolean(id));

  return pausarCampanhasAtivas(
    admin,
    {
      organizationId: session.organizationId,
      channelSessionIds: sessoes,
      templateName: e.templateName,
      templateLanguage: e.templateLanguage,
    },
    estado === "PAUSED"
      ? { motivo: "modelo_pausado", detalhe: `A Meta pausou o modelo "${e.templateName}"${e.reason ? ` (${e.reason})` : ""}.` }
      : { motivo: "modelo_desativado", detalhe: `O modelo "${e.templateName}" ficou ${estado} na Meta${e.reason ? ` (${e.reason})` : ""}.` },
  );
}

/** Só os dígitos: a Meta manda o telefone formatado de um jeito, o CRM grava de outro. */
function digitos(telefone: string | null | undefined): string {
  return (telefone ?? "").replace(/\D/g, "");
}

/** Qualidade ou limite do número mudou: grava; sinalizado (FLAGGED) pausa as campanhas dele. */
export async function aplicarQualidadeDoNumero(
  admin: Admin,
  session: MetaWebhookSession,
  e: PhoneQualityEvent,
): Promise<string> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, display_name, phone_number")
    .eq("organization_id", session.organizationId)
    .eq("meta_waba_id", e.wabaId)
    .is("archived_at", null);
  const alvo = digitos(e.displayPhoneNumber);
  const sessoes = ((data ?? []) as Array<{ id: string; display_name: string | null; phone_number: string | null }>)
    .filter((s) => {
      const d = digitos(s.phone_number);
      return d.length > 0 && (d.endsWith(alvo) || alvo.endsWith(d));
    });
  if (sessoes.length === 0) return "phone_quality:numero_desconhecido";

  const agora = new Date().toISOString();
  // FLAGGED = qualidade baixa (vermelha). UNFLAGGED volta ao "não sei": a checagem de saúde
  // lê a nota exata da Graph em até 5 minutos — inventar "verde" aqui seria mentir.
  const nota = e.event === "FLAGGED" ? { meta_quality_rating: "RED" } : e.event === "UNFLAGGED" ? { meta_quality_rating: null } : {};
  for (const s of sessoes) {
    await admin
      .from("channel_sessions")
      .update({
        ...nota,
        meta_quality_event: e.event,
        ...(e.currentLimit ? { meta_messaging_limit: e.currentLimit } : {}),
        meta_quality_updated_at: agora,
      })
      .eq("id", s.id)
      .eq("organization_id", session.organizationId);
  }

  const nome = sessoes[0]!.display_name ?? e.displayPhoneNumber;
  if (e.event === "DOWNGRADE") {
    await registrarAviso(admin, session.organizationId, {
      kind: "channel_number_alert",
      severity: "warn",
      title: `O limite de envios de "${nome}" caiu`,
      body: e.currentLimit ? `Novo limite segundo a Meta: ${e.currentLimit}.` : null,
    });
  }
  if (e.event !== "FLAGGED") return `phone_quality:${e.event}`;

  const n = await pausarCampanhasAtivas(
    admin,
    { organizationId: session.organizationId, channelSessionIds: sessoes.map((s) => s.id) },
    { motivo: "numero_qualidade_baixa", detalhe: `A Meta sinalizou o número "${nome}" com qualidade baixa.` },
  );
  return `phone_quality:FLAGGED:pausadas=${n}`;
}

/** Severidades que param campanha. INFORMATIONAL só informa. */
const SEVERIDADES_QUE_PARAM = new Set(["CRITICAL", "WARNING"]);

/** Alerta da Meta na conta: avisa e, se for de atenção ou crítico, pausa as campanhas da conta. */
export async function aplicarAlertaDaConta(
  admin: Admin,
  session: MetaWebhookSession,
  e: AccountAlertEvent,
): Promise<string> {
  // Alerta encerrado (`NONE`) não é motivo novo para parar nada.
  if (e.status && e.status.toUpperCase() === "NONE") return "account_alert:encerrado";

  await registrarAviso(admin, session.organizationId, {
    kind: "channel_number_alert",
    severity: e.severity === "CRITICAL" ? "critical" : e.severity === "WARNING" ? "warn" : "info",
    title: `Alerta da Meta na conta do WhatsApp${e.alertType ? `: ${e.alertType}` : ""}`,
    body: e.description,
  });
  if (!SEVERIDADES_QUE_PARAM.has(e.severity)) return `account_alert:${e.severity}`;

  // Alerta de UM número pausa só as campanhas dele; da conta (ou do negócio), todas.
  let sessoes = await sessoesDaConta(admin, session, e.wabaId);
  if (e.entityType?.toUpperCase() === "PHONE_NUMBER" && e.entityId) {
    const { data } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", session.organizationId)
      .eq("meta_phone_number_id", e.entityId);
    const doNumero = ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
    if (doNumero.length > 0) sessoes = doNumero;
  }

  const n = await pausarCampanhasAtivas(
    admin,
    { organizationId: session.organizationId, channelSessionIds: sessoes },
    { motivo: "alerta_da_conta", detalhe: e.description ?? `A Meta enviou um alerta ${e.severity} para a conta.` },
  );
  return `account_alert:${e.severity}:pausadas=${n}`;
}

/** Violação, restrição ou banimento da conta (`account_update`): pausa todas as campanhas dela. */
export async function pausarPorAvisoDaConta(
  admin: Admin,
  session: MetaWebhookSession,
  e: AccountUpdateEvent,
): Promise<number> {
  const banida = e.event === "DISABLED_UPDATE" && (e.banState === "DISABLE" || e.banState === "SCHEDULE_FOR_DISABLE");
  if (e.event !== "ACCOUNT_VIOLATION" && e.event !== "ACCOUNT_RESTRICTION" && !banida) return 0;

  const detalhe =
    e.event === "ACCOUNT_VIOLATION"
      ? `A Meta registrou uma violação na conta${e.violationType ? ` (${e.violationType})` : ""}.`
      : e.event === "ACCOUNT_RESTRICTION"
        ? `A Meta restringiu a conta${e.restrictionType ? ` (${e.restrictionType})` : ""}.`
        : "A Meta desativou ou agendou a desativação da conta do WhatsApp.";

  return pausarCampanhasAtivas(
    admin,
    { organizationId: session.organizationId, channelSessionIds: await sessoesDaConta(admin, session, e.wabaId) },
    { motivo: "violacao_da_conta", detalhe },
  );
}
