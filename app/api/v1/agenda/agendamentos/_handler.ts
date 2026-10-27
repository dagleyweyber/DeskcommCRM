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
import { SalaInvalida, TipoDeCompromissoInvalido, horarioEstaLivre, type OrigemDaConsulta } from "@/lib/agenda/consulta";
import type { Compromisso, HorarioLivre } from "@/lib/agenda/tipos";
import { logger } from "@/lib/logger";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type {
  AlterarAgendamentoInput,
  CancelarAgendamentoInput,
  MarcarAgendamentoInput,
} from "@/lib/schemas/agenda";

const COLUNAS = "id, organization_id, event_type_id, room_id, title, description, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, cancelled_at, cancellation_reason, rescheduled_from_id, revision";

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
      ? // Fuso explícito: o servidor roda em UTC, e sem isto a timeline dizia 13:00 para uma visita às 10:00.
        `Compromisso agendado pela Agenda para ${new Date(compromisso.starts_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: compromisso.time_zone || "America/Sao_Paulo" })}`
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

  if (evento.tipo === "meeting_scheduled") {
    await moverParaEtapaDeAgendamento(admin, ctx, resolucao.leadId);
  }
}

/** "Avaliação Agendada", "Visita agendada", "Agendado"… — sem acento e sem caixa. */
function ehEtapaDeAgendamento(nome: string): boolean {
  return /agendad/.test(
    nome
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase(),
  );
}

/**
 * Agendou → o card anda para a etapa de agendamento do funil (pedido do dono
 * do produto: Agenda e Kanban contam a mesma história). A etapa é achada pelo
 * NOME ("agendad"), no MESMO funil do negócio — o funil padrão novo já tem
 * "Avaliação Agendada" (migration 0190), e cada clínica renomeia como quiser.
 *
 * Só para FRENTE: negócio já em "Negociação", ganho ou perdido não volta. Sem
 * etapa com esse nome, nada acontece. Fire-and-forget como o resto de
 * `fecharOLaco` — a marcação já está segura; isto é o reflexo no funil.
 */
async function moverParaEtapaDeAgendamento(admin: SupabaseClient, ctx: HandlerCtx, leadId: string): Promise<void> {
  try {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("id, organization_id, pipeline_id, stage_id, contact_id, status")
      .eq("organization_id", ctx.organization_id)
      .eq("id", leadId)
      .maybeSingle();
    const l = lead as { pipeline_id: string; stage_id: string; contact_id: string | null; status: string } | null;
    if (!l || l.status !== "open") return;

    const { data: etapas } = await admin
      .from("crm_stages")
      .select("id, name, position, is_won, is_lost, is_archived")
      .eq("organization_id", ctx.organization_id)
      .eq("pipeline_id", l.pipeline_id);
    const lista = (etapas ?? []) as {
      id: string;
      name: string;
      position: number;
      is_won: boolean;
      is_lost: boolean;
      is_archived: boolean;
    }[];
    const atual = lista.find((e) => e.id === l.stage_id);
    const alvo = lista
      .filter((e) => !e.is_archived && !e.is_won && !e.is_lost && ehEtapaDeAgendamento(e.name))
      .sort((a, b) => Number(a.position) - Number(b.position))[0];
    if (!atual || !alvo || alvo.id === atual.id) return;
    if (Number(atual.position) >= Number(alvo.position)) return; // só para frente

    // Entra no FIM da coluna (fractional indexing: maior posição + 1000).
    const { data: ultimo } = await admin
      .from("crm_leads")
      .select("position_in_stage")
      .eq("organization_id", ctx.organization_id)
      .eq("stage_id", alvo.id)
      .order("position_in_stage", { ascending: false })
      .limit(1)
      .maybeSingle();
    const posicao = Number((ultimo as { position_in_stage?: number } | null)?.position_in_stage ?? 0) + 1000;

    const { data: movido, error } = await admin
      .from("crm_leads")
      .update({ stage_id: alvo.id, position_in_stage: posicao, updated_at: new Date().toISOString() })
      .eq("organization_id", ctx.organization_id)
      .eq("id", leadId)
      .eq("stage_id", atual.id) // trava otimista: alguém moveu no meio → não sobrescreve
      .select("id")
      .maybeSingle();
    if (error || !movido) return;

    const atividade = await emitLeadActivity(admin, {
      organizationId: ctx.organization_id,
      leadId,
      contactId: l.contact_id,
      type: "stage_changed",
      sourceModule: "agenda.agendamentos",
      sourceId: leadId,
      actor: ctx.actor,
      reason: stageChangeReason(atual.name, alvo.name),
      payload: { from_stage_id: atual.id, to_stage_id: alvo.id, pipeline_id: l.pipeline_id },
    });
    if (!atividade.ok) {
      await registraFalhaDeAtividade(admin, {
        organizationId: ctx.organization_id,
        leadId,
        tipo: "stage_changed",
        origem: "agenda._handler.moverParaEtapaDeAgendamento",
        erro: atividade.error,
        requestId: ctx.requestId,
      });
    }
  } catch (err) {
    logger.error("[agenda.moverParaEtapaDeAgendamento] falhou", {
      organization_id: ctx.organization_id,
      lead_id: leadId,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Origem da régua de disponibilidade: a IA respeita a janela do serviço; a equipe, não (ver consulta.ts). */
function origemDo(ctx: HandlerCtx): OrigemDaConsulta {
  return ctx.actor.type === "ai_agent" ? "ia" : "equipe";
}

/**
 * INSERT/UPDATE protegido: entre a checagem de horário livre e a escrita,
 * outra marcação pode ter ocupado a sala — a constraint de exclusão
 * `calendar_appointments_sala_sem_sobreposicao` (migration 0200) recusa com
 * 23P01, e isso é conflito de horário (409), não erro interno.
 */
function erroDeEscrita(ctx: HandlerCtx, err: { code?: string; message?: string } | null): ApiError {
  if (err?.code === "23P01") {
    return new ApiError(409, "conflict", undefined, ctx.requestId, "Este horário acabou de ser ocupado nesta sala. Escolha outro.");
  }
  return new ApiError(500, "internal_error", undefined, ctx.requestId, err?.message ?? "write_failed");
}

async function confereHorario(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  params: { eventTypeId: string; roomId: string | null; startsAt: string; ignorarCompromissoId?: string },
): Promise<HorarioLivre> {
  let livre: HorarioLivre | null;
  try {
    livre = await horarioEstaLivre(
      admin,
      {
        organizationId: ctx.organization_id,
        eventTypeId: params.eventTypeId,
        roomId: params.roomId,
        agora: new Date(),
        origem: origemDo(ctx),
        ignorarCompromissoId: params.ignorarCompromissoId ?? null,
      },
      params.startsAt,
    );
  } catch (err) {
    if (err instanceof TipoDeCompromissoInvalido) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Tipo de compromisso inválido ou inativo.");
    }
    if (err instanceof SalaInvalida) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Sala inválida, inativa ou não permitida para este serviço.");
    }
    throw err;
  }
  if (!livre) {
    throw new ApiError(409, "conflict", undefined, ctx.requestId, "Este horário não está mais disponível.");
  }
  return livre;
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

  // Confere contra o MESMO motor que publicou o horário — nunca confia cegamente
  // no que o cliente mandou de volta (a grade pode estar desatualizada numa aba parada).
  // Sem sala informada, o motor escolhe a primeira sala livre permitida para o serviço.
  const livre = await confereHorario(admin, ctx, {
    eventTypeId: input.event_type_id,
    roomId: input.room_id ?? null,
    startsAt: input.starts_at,
  });

  // Profissional é OPCIONAL desde a 0200 (a sala trava o horário): o informado,
  // senão o padrão do serviço, senão nenhum.
  const ownerUserId = input.owner_user_id ?? ((tipo.default_owner_user_id as string | null) || null);

  const startsAt = new Date(livre.starts_at);
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
      room_id: livre.room_id,
      title: input.title ?? `Compromisso com ${(contato as { display_name: string | null }).display_name ?? "contato"}`,
      description: input.description ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      // "Agendado" — `confirmed` é reservado para quando o CLIENTE confirma.
      status: "pending",
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
  if (insErr || !criado) throw erroDeEscrita(ctx, insErr);
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

/**
 * Edita um compromisso.
 *
 * - Mudou o DIA/HORA ou o SERVIÇO → REMARCA: cancela o antigo (motivo
 *   "Remarcado") e cria um novo com `rescheduled_from_id` — histórico de
 *   reagendamentos sem sobrescrever (mesmo raciocínio de `meeting_scheduled`
 *   na 0158: cada remarcação é um evento novo). O novo nasce "Agendado": a
 *   confirmação do horário antigo não vale para o novo.
 * - Mudou só sala/profissional/status/observação → edita no lugar. Trocar de
 *   sala confere se a sala nova está livre no mesmo horário.
 */
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
  if (compromissoAtual.revision !== input.revision) {
    throw new ApiError(409, "conflict", undefined, ctx.requestId, "Compromisso foi alterado por outra pessoa — recarregue.");
  }

  const mudouHorario =
    input.starts_at !== undefined && new Date(input.starts_at).getTime() !== new Date(compromissoAtual.starts_at).getTime();
  const mudouServico = input.event_type_id !== undefined && input.event_type_id !== compromissoAtual.event_type_id;
  const salaPedida = input.room_id !== undefined ? input.room_id : compromissoAtual.room_id;
  const profissional = input.owner_user_id !== undefined ? input.owner_user_id : compromissoAtual.owner_user_id;

  if (mudouHorario || mudouServico) {
    const eventTypeId = input.event_type_id ?? compromissoAtual.event_type_id;
    if (!eventTypeId) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Escolha o serviço para remarcar.");
    }
    const { data: tipo } = await admin
      .from("calendar_event_types")
      .select("duration_minutes")
      .eq("organization_id", ctx.organization_id)
      .eq("id", eventTypeId)
      .maybeSingle();
    const duracaoMs =
      ((tipo?.duration_minutes as number | undefined) ??
        (new Date(compromissoAtual.ends_at).getTime() - new Date(compromissoAtual.starts_at).getTime()) / 60_000) *
      60_000;

    const livre = await confereHorario(admin, ctx, {
      eventTypeId,
      roomId: salaPedida,
      startsAt: input.starts_at ?? compromissoAtual.starts_at,
      ignorarCompromissoId: id,
    });

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
    const remarcadoDe = cancelado as unknown as Compromisso;

    const novoInicio = new Date(livre.starts_at);
    const { data: criado, error: insErr } = await admin
      .from("calendar_appointments")
      .insert({
        organization_id: ctx.organization_id,
        event_type_id: eventTypeId,
        room_id: livre.room_id,
        title: compromissoAtual.title,
        description: compromissoAtual.description,
        starts_at: novoInicio.toISOString(),
        ends_at: new Date(novoInicio.getTime() + duracaoMs).toISOString(),
        status: "pending",
        owner_user_id: profissional,
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
    if (insErr || !criado) {
      // O antigo já foi cancelado: devolve-o ao estado anterior para a falha
      // não sumir com o compromisso da grade (melhor esforço — o erro segue).
      await admin
        .from("calendar_appointments")
        .update({ status: compromissoAtual.status, cancelled_at: null, cancellation_reason: null, revision: compromissoAtual.revision + 2 })
        .eq("id", id)
        .eq("organization_id", ctx.organization_id);
      throw erroDeEscrita(ctx, insErr);
    }

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

  const patch: Record<string, unknown> = { revision: compromissoAtual.revision + 1 };
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.owner_user_id !== undefined) patch.owner_user_id = input.owner_user_id;
  if (input.status && input.status !== compromissoAtual.status) {
    patch.status = input.status;
    // A equipe mudou o status: deixa de ser "respondido pelo cliente" (0201).
    patch.client_responded_at = null;
  }

  if (input.room_id !== undefined && input.room_id !== compromissoAtual.room_id) {
    if (!input.room_id) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Escolha uma sala.");
    }
    if (!compromissoAtual.event_type_id) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Compromisso sem serviço — remarque escolhendo o serviço.");
    }
    const livre = await confereHorario(admin, ctx, {
      eventTypeId: compromissoAtual.event_type_id,
      roomId: input.room_id,
      startsAt: compromissoAtual.starts_at,
      ignorarCompromissoId: id,
    });
    patch.room_id = livre.room_id;
  }

  const { data: atualizado, error: updErr } = await admin
    .from("calendar_appointments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", ctx.organization_id)
    .eq("revision", input.revision)
    .select(COLUNAS)
    .maybeSingle();
  if (updErr) throw erroDeEscrita(ctx, updErr);
  if (!atualizado) throw new ApiError(409, "conflict", undefined, ctx.requestId, "Compromisso foi alterado por outra pessoa — recarregue.");
  const compromisso = atualizado as unknown as Compromisso;

  await audit({
    action: "calendar_appointment.updated",
    organizationId: ctx.organization_id,
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    resourceType: "calendar_appointment",
    resourceId: compromisso.id,
    metadata: { campos: Object.keys(patch).filter((k) => k !== "revision") },
    requestId: ctx.requestId,
  });

  if (input.status && input.status !== compromissoAtual.status && (input.status === "completed" || input.status === "no_show")) {
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
