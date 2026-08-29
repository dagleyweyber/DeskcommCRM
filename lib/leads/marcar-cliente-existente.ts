/**
 * "CLIENTE JÁ EXISTENTE" — Fase 3: reconhecimento MANUAL (padrão HubSpot/
 * Close.com; contexto completo na migration 0164_contato_ja_e_cliente).
 *
 * Desfecho TERMINAL do card, mesmo slot conceitual que won/lost — mas SEM
 * stage de fechamento correspondente. `encerraDemanda` (won/lost) move o
 * lead pro stage `is_won`/`is_lost`, e o trigger `fn_crm_lead_close_on_stage`
 * deriva `status`/`closed_at` a partir da POSIÇÃO no funil. "Cliente já
 * existente" não tem stage nenhuma — a Fase 4 tira o card do board pelo
 * `status`, não por posição — então este módulo grava `status`/`closed_at`
 * DIRETO, por fora de `encerraDemanda`: são dois mecanismos de fechamento
 * diferentes, forçar o terceiro caso dentro do primeiro faria os dois
 * caberem mal.
 *
 * ⚠️ O trigger só dispara em `UPDATE OF stage_id` (ver baseline.sql,
 * trg_crm_lead_close_on_stage) — como este UPDATE nunca toca `stage_id`, ele
 * não interfere aqui, e por isso é seguro escrever `status` à mão só neste
 * caminho específico.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";

export interface MarcarClienteExistenteInput {
  leadId: string;
}

export interface ClienteExistenteMarcado {
  lead: Record<string, unknown>;
  /** `true` = já estava marcado; nada foi alterado (idempotente). */
  jaEstava: boolean;
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: { actor_type: actor.type, actor_id: actor.id },
  };
}

export async function marcarClienteExistente(
  supabase: SupabaseClient,
  ctx: HandlerCtx,
  input: MarcarClienteExistenteInput,
): Promise<ClienteExistenteMarcado> {
  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!lead) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const contactId = (lead as { contact_id: string | null }).contact_id;
  if (!contactId) {
    throw new ApiError(
      422,
      "lead_sem_contato",
      undefined,
      ctx.requestId,
      "Este negócio não tem contato vinculado — não há quem reconhecer como cliente.",
    );
  }

  if ((lead as { status: string }).status === "existing_customer") {
    return { lead: lead as Record<string, unknown>, jaEstava: true };
  }

  const agora = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("crm_leads")
    .update({ status: "existing_customer", closed_at: agora, updated_at: agora })
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id);

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }

  // `became_customer_at` é do CONTATO, não do lead. `.is(..., null)` faz o
  // papel do `coalesce`: só grava se ainda não houver data — uma 2ª demanda
  // de quem já é cliente (Fase 2 já preencheu, ou reconhecimento manual
  // anterior) não pode reescrever "desde quando" ele é cliente.
  const { error: contactErr } = await supabase
    .from("contacts")
    .update({ became_customer_at: agora })
    .eq("id", contactId)
    .eq("organization_id", ctx.organization_id)
    .is("became_customer_at", null);
  if (contactErr) {
    // Mesma prioridade de `encerraDemanda`: o desfecho do lead já aconteceu e
    // não pode ficar refém de um efeito colateral — mas a falha é CONTADA.
    await registraFalhaDeAtividade(supabase, {
      organizationId: ctx.organization_id,
      leadId: input.leadId,
      tipo: "contacts.became_customer_at",
      origem: "lib/leads/marcar-cliente-existente.marcarClienteExistente",
      erro: contactErr.message,
      requestId: ctx.requestId,
    });
  }

  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  const finalLead = (fresh ?? lead) as Record<string, unknown>;

  const a = actorAuditPayload(ctx.actor);

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.marked_existing_customer",
      p_entity_kind: "crm_lead",
      p_entity_id: input.leadId,
      p_payload: { contact_id: contactId },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: ctx.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.marked_existing_customer] emit_event failed", error.message);
    });

  // Mesmo `type` de won/lost (`demand_closed`) — é o MESMO slot conceitual
  // (ver doc do módulo), só muda o `reason`. Vocabulário novo pra dizer a
  // mesma coisa fragmentaria a timeline sem necessidade.
  const atividade = await emitLeadActivity(supabase, {
    organizationId: ctx.organization_id,
    leadId: input.leadId,
    contactId,
    type: "demand_closed",
    sourceModule: "crm",
    sourceId: input.leadId,
    actor: ctx.actor,
    reason: "Cliente já existente",
    payload: { desfecho: "existing_customer" },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: ctx.organization_id,
      leadId: input.leadId,
      tipo: "demand_closed",
      origem: "lib/leads/marcar-cliente-existente.marcarClienteExistente",
      erro: atividade.error,
      requestId: ctx.requestId,
    });
  }

  await audit({
    action: "lead.marked_existing_customer",
    actorUserId: a.actorUserId,
    organizationId: ctx.organization_id,
    resourceType: "crm_lead",
    resourceId: input.leadId,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, contact_id: contactId },
  });

  return { lead: finalLead, jaEstava: false };
}
