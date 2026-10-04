/**
 * Lógica de marcar/alterar/cancelar compromisso — compartilhada entre a rota
 * REST (`route.ts`/`[id]/route.ts`) e a ferramenta MCP do agente de IA
 * (`lib/mcp/tools/agendamento.ts`), mesmo padrão de `app/api/v1/messages/
 * _handler.ts`: UI e IA nunca podem divergir sobre a regra de negócio.
 * `organization_id` sempre chega via `ctx`, nunca é resolvido aqui — quem
 * chama já validou (cookie de sessão ou contexto do agente).
 *
 * Concorrência otimista: `revision` incrementa a cada UPDATE bem-sucedido,
 * conferida em TypeScript (`update().eq("revision", ...)`), não stored
 * procedure — mesmo padrão de trava já usado por `lib/leads/stage-operations.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { horarioEstaLivre } from "@/lib/agenda/consulta";
import type { Compromisso } from "@/lib/agenda/tipos";
import { logger } from "@/lib/logger";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type {
  AlterarAgendamentoInput,
  CancelarAgendamentoInput,
  MarcarAgendamentoInput,
} from "@/lib/schemas/agenda";

const COLUNAS = "id, organization_id, event_type_id, title, description, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, cancelled_at, cancellation_reason, rescheduled_from_id, revision";

/**
 * Resolve o negócio ABERTO deste contato (mesma função que o resto do CRM
 * usa) e fecha o laço: emite `meeting_scheduled`/`meeting_outcome` na
 * timeline do negócio — o MESMO vocabulário que `leads/[id]/meetings/
 * schedule|outcome` já usa, que o Dashboard de Vendas (funil de agendamento,
 * migrations 0158/0166) já lê. Reusar em vez de inventar um sinal novo: a
 * grade da Agenda e o funil do dashboard nunca podem contar números
 * diferentes para a mesma marcação.
 *
 * Fire-and-forget deliberado (não falha a marcação se isto falhar) — mesmo
 * raciocínio de `moverLeadParaEtapaDeAgendamento` no upstream: a timeline é
 * enriquecimento, a marcação em si já está segura em `calendar_appointments`.
 */
async function fecharOLaco(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  compromisso: Compromisso,
  evento: { tipo: "meeting_scheduled" } | { tipo: "meeting_outcome"; outcome: "attended" | "no_show" },
): Promise<void> {
  const { data: candidatos, error } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", ctx.organization_id)
    .eq("contact_id", compromisso.contact_id);
  if (error) {
    // Ainda não há leadId resolvido (a própria busca falhou) — sem alvo pra
    // registrar a falha como atividade de negócio; loga e segue (a marcação
    // em si já está segura, isto é só enriquecimento da timeline).
    logger.error("[agenda.fecharOLaco] busca de leads falhou", {
      organization_id: ctx.organization_id,
      appointment_id: compromisso.id,
      erro: error.message,
    });
    return;
  }

  const resolucao = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[]);
  if (!resolucao.routed) return; // sem negócio aberto: marcação continua válida, só não ganha timeline.

  const payload =
    evento.tipo === "meeting_scheduled"
      ? { scheduled_at: compromisso.starts_at }
      : { outcome: evento.outcome, scheduled_at: compromisso.starts_at };
  const reason =
    evento.tipo === "meeting_scheduled"
      ? `Compromisso agendado pela Agenda para ${new Date(compromisso.starts_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
      : evento.outcome === "attended"
        ? "Compareceu (registrado pela Agenda)"
        : "Não compareceu (registrado pela Agenda)";

  const emitido = await emitLeadActivity(admin, {
    organizationId: ctx.organization_id,
    leadId: resolucao.leadId,
    contactId: compromisso.contact_id,
    type: evento.tipo,
    sourceModule: "agenda.agendamentos",
    sourceId: compromisso.id,
    actor: ctx.actor,
    reason,
    payload,
  });
  if (!emitido.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: ctx.organization_id,
      leadId: resolucao.leadId,
      tipo: evento.tipo,
      origem: "agenda._handler.fecharOLaco",
      erro: emitido.error,
      requestId: ctx.requestId,
    });
  }
}

export async function marcarAgendamentoHandler(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  input: MarcarAgendamentoInput,
): Promise<Compromisso> {
  const { data: tipo, error: tipoErr } = await admin
    .from("calendar_event_types")
    .select("id, duration_minutes, default_owner_user_id, location_kind, is_active")
    .eq("organization_id", ctx.organization_id)
    .eq("id", input.event_type_id)
    .maybeSingle();
  if (tipoErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, tipoErr.message);
  if (!tipo || !tipo.is_active) {
    throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Tipo de compromisso inválido ou inativo.");
  }

  const ownerUserId = input.owner_user_id || (tipo.default_owner_user_id as string | null);
  if (!ownerUserId) {
    throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Informe o dono do compromisso — este tipo não tem um padrão.");
  }

  // Confere contra o MESMO motor que publicou o horário — nunca confia cegamente
  // no que o cliente mandou de volta (a grade pode estar desatualizada numa aba parada).
  const livre = await horarioEstaLivre(
    admin,
    { organizationId: ctx.organization_id, eventTypeId: input.event_type_id, ownerUserId, agora: new Date() },
    input.starts_at,
  );
  if (!livre) {
    throw new ApiError(409, "conflict", undefined, ctx.requestId, "Este horário não está mais disponível.");
  }

  const startsAt = new Date(input.starts_at);
  const endsAt = new Date(startsAt.getTime() + (tipo.duration_minutes as number) * 60_000);

  const { data: contato, error: contatoErr } = await admin
    .from("contacts")
    .select("id, display_name")
    .eq("organization_id", ctx.organization_id)
    .eq("id", input.contact_id)
    .maybeSingle();
  if (contatoErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, contatoErr.message);
  if (!contato) throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");

  const { data: criado, error: insErr } = await admin
    .from("calendar_appointments")
    .insert({
      organization_id: ctx.organization_id,
      event_type_id: input.event_type_id,
      title: input.title ?? `Compromisso com ${(contato as { display_name: string | null }).display_name ?? "contato"}`,
      description: input.description ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "confirmed",
      owner_user_id: ownerUserId,
      contact_id: input.contact_id,
      conversation_id: input.conversation_id ?? null,
      location_kind: tipo.location_kind,
      location_detail: input.location_detail ?? null,
      notes: input.notes ?? null,
      created_by_kind: ctx.actor.type === "ai_agent" ? "ai_agent" : "user",
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
      created_by_agent_id: ctx.actor.type === "ai_agent" ? ctx.actor.id : null,
      source: ctx.actor.type === "ai_agent" ? "ai_agent" : "manual",
    })
    .select(COLUNAS)
    .single();
  if (insErr || !criado) {
    // 23P01 = exclusion violation; não temos constraint de exclusão nesta fase,
    // mas 409 por segurança caso duas marcações concorrentes colidam na janela
    // entre a checagem acima e o INSERT.
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, insErr?.message ?? "insert_failed");
  }
  const compromisso = criado as unknown as Compromisso;

  await audit({
    action: "calendar_appointment.created",
    organizationId: ctx.organization_id,
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    resourceType: "calendar_appointment",
    resourceId: compromisso.id,
    requestId: ctx.requestId,
  });

  await fecharOLaco(admin, ctx, compromisso, { tipo: "meeting_scheduled" });

  return compromisso;
}

export async function alterarAgendamentoHandler(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  id: string,
  input: AlterarAgendamentoInput,
): Promise<Compromisso> {
  const { data: atual, error: buscaErr } = await admin
    .from("calendar_appointments")
    .select(COLUNAS)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (buscaErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, buscaErr.message);
  if (!atual) throw new ApiError(404, "not_found", undefined, ctx.requestId, "Compromisso não encontrado.");
  const compromissoAtual = atual as unknown as Compromisso;

  if (compromissoAtual.status === "cancelled") {
    throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Compromisso já cancelado.");
  }

  const patch: Record<string, unknown> = { revision: compromissoAtual.revision + 1 };
  if (input.notes !== undefined) patch.notes = input.notes;

  let remarcadoDe: Compromisso | null = null;
  if (input.starts_at) {
    // Remarcar = CANCELA o antigo (motivo "remarcado") e CRIA um novo com
    // `rescheduled_from_id` apontando pra ele — histórico de reagendamentos
    // sem sobrescrever (mesmo raciocínio de `meeting_scheduled` na 0158:
    // cada remarcação é um evento novo, o passado fica).
    const { data: tipo } = await admin
      .from("calendar_event_types")
      .select("duration_minutes")
      .eq("id", compromissoAtual.event_type_id ?? "")
      .maybeSingle();
    const duracaoMs =
      ((tipo?.duration_minutes as number | undefined) ??
        (new Date(compromissoAtual.ends_at).getTime() - new Date(compromissoAtual.starts_at).getTime()) / 60_000) *
      60_000;

    const livre = await horarioEstaLivre(
      admin,
      {
        organizationId: ctx.organization_id,
        eventTypeId: compromissoAtual.event_type_id ?? "",
        ownerUserId: compromissoAtual.owner_user_id ?? "",
        agora: new Date(),
      },
      input.starts_at,
    );
    if (!livre) throw new ApiError(409, "conflict", undefined, ctx.requestId, "Este horário não está mais disponível.");

    const { data: cancelado, error: cancelErr } = await admin
      .from("calendar_appointments")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_reason: "Remarcado", revision: compromissoAtual.revision + 1 })
      .eq("id", id)
      .eq("organization_id", ctx.organization_id)
      .eq("revision", input.revision)
      .select(COLUNAS)
      .maybeSingle();
    if (cancelErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, cancelErr.message);
    if (!cancelado) throw new ApiError(409, "conflict", undefined, ctx.requestId, "Compromisso foi alterado por outra pessoa — recarregue.");
    remarcadoDe = cancelado as unknown as Compromisso;

    const novoInicio = new Date(input.starts_at);
    const { data: criado, error: insErr } = await admin
      .from("calendar_appointments")
      .insert({
        organization_id: ctx.organization_id,
        event_type_id: compromissoAtual.event_type_id,
        title: compromissoAtual.title,
        description: compromissoAtual.description,
        starts_at: novoInicio.toISOString(),
        ends_at: new Date(novoInicio.getTime() + duracaoMs).toISOString(),
        status: "confirmed",
        owner_user_id: compromissoAtual.owner_user_id,
        contact_id: compromissoAtual.contact_id,
        conversation_id: compromissoAtual.conversation_id,
        location_kind: compromissoAtual.location_kind,
        location_detail: compromissoAtual.location_detail,
        notes: input.notes !== undefined ? input.notes : compromissoAtual.notes,
        rescheduled_from_id: remarcadoDe.id,
        created_by_kind: ctx.actor.type === "ai_agent" ? "ai_agent" : "user",
        created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
        created_by_agent_id: ctx.actor.type === "ai_agent" ? ctx.actor.id : null,
        source: ctx.actor.type === "ai_agent" ? "ai_agent" : "manual",
      })
      .select(COLUNAS)
      .single();
    if (insErr || !criado) throw new ApiError(500, "internal_error", undefined, ctx.requestId, insErr?.message ?? "insert_failed");

    await audit({
      action: "calendar_appointment.rescheduled",
      organizationId: ctx.organization_id,
      actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      resourceType: "calendar_appointment",
      resourceId: (criado as { id: string }).id,
      metadata: { from_id: remarcadoDe.id },
      requestId: ctx.requestId,
    });

    const novoCompromisso = criado as unknown as Compromisso;
    await fecharOLaco(admin, ctx, novoCompromisso, { tipo: "meeting_scheduled" });
    return novoCompromisso;
  }

  if (input.status) patch.status = input.status;

  const { data: atualizado, error: updErr } = await admin
    .from("calendar_appointments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .eq("revision", input.revision)
    .select(COLUNAS)
    .maybeSingle();
  if (updErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  if (!atualizado) throw new ApiError(409, "conflict", undefined, ctx.requestId, "Compromisso foi alterado por outra pessoa — recarregue.");
  const compromisso = atualizado as unknown as Compromisso;

  if (input.status === "completed" || input.status === "no_show") {
    await fecharOLaco(admin, ctx, compromisso, { tipo: "meeting_outcome", outcome: input.status === "completed" ? "attended" : "no_show" });
  }

  return compromisso;
}

export async function cancelarAgendamentoHandler(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  id: string,
  input: CancelarAgendamentoInput,
): Promise<Compromisso> {
  const { data: atual, error: buscaErr } = await admin
    .from("calendar_appointments")
    .select(COLUNAS)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (buscaErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, buscaErr.message);
  if (!atual) throw new ApiError(404, "not_found", undefined, ctx.requestId, "Compromisso não encontrado.");
  const compromissoAtual = atual as unknown as Compromisso;

  // Idempotente: cancelar um já-cancelado devolve sucesso, não erro — mesmo
  // padrão do cancelamento de follow-up e de campanha neste repo.
  if (compromissoAtual.status === "cancelled") return compromissoAtual;

  const { data: cancelado, error: updErr } = await admin
    .from("calendar_appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: input.reason,
      revision: compromissoAtual.revision + 1,
    })
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .eq("revision", input.revision)
    .select(COLUNAS)
    .maybeSingle();
  if (updErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  if (!cancelado) throw new ApiError(409, "conflict", undefined, ctx.requestId, "Compromisso foi alterado por outra pessoa — recarregue.");

  await audit({
    action: "calendar_appointment.cancelled",
    organizationId: ctx.organization_id,
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    resourceType: "calendar_appointment",
    resourceId: id,
    metadata: { reason: input.reason },
    requestId: ctx.requestId,
  });

  return cancelado as unknown as Compromisso;
}
