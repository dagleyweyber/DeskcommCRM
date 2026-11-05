/**
 * GET   /api/v1/automations/[id] — detalhe + últimos envios (paginado).
 * PATCH /api/v1/automations/[id] — edita a configuração (nome, modelo, variáveis,
 *       serviço, momento, botões). Canal e gatilho NÃO mudam: são a identidade da
 *       automação — para outro canal ou outro gatilho, cria-se outra.
 *
 * Editar vale com a automação em qualquer estado (rascunho, ativa, pausada) e as
 * regras são as da criação (`lib/automations/configuracao.ts`), mais duas que só
 * existem por ela já estar viva:
 *  - trocar o TEXTO dos botões é recusado enquanto houver confirmação aguardando
 *    resposta: a resposta do cliente é casada com o texto ATUAL, e as mensagens já
 *    enviadas perderiam a confirmação em silêncio;
 *  - mexer em serviço ou momento de uma automação ATIVA reconfere a trava de "uma
 *    ativa por serviço e momento" — senão a edição seria o jeito de mandar em dobro.
 * O que já foi enviado não é reenviado: a dedup é por (automação, compromisso).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  acharConflitoDeAtivacao,
  camposAlterados,
  confirmacoesAguardandoResposta,
  fraseDoConflito,
  MENSAGEM_MOMENTO_INVALIDO,
  momentoValido,
  mudouAlvoOuMomento,
  mudouBotoes,
  validarConfiguracao,
  type ConfiguracaoDaAutomacao,
} from "@/lib/automations/configuracao";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";
import { createAdminClient } from "@/lib/supabase/admin";

import { variableSourceSchema } from "../_schema";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const idSchema = z.string().uuid();

const COLUNAS_DA_CONFIGURACAO =
  "name, template_name, template_language, variable_mapping, event_type_id, timing_kind, timing_value, confirm_button_text, decline_button_text";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: automacao } = await admin
    .from("whatsapp_template_automations")
    .select(
      `id, trigger_kind, channel_session_id, status, created_at, updated_at, ${COLUNAS_DA_CONFIGURACAO}`,
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!automacao) return fail("not_found", "Automação não encontrada.", 404, { requestId });

  const { data: envios } = await admin
    .from("whatsapp_template_automation_sends")
    .select("id, lead_id, contact_id, status, external_id, error_message, sent_at")
    .eq("automation_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("sent_at", { ascending: false })
    .limit(PAGE_SIZE);

  return ok({ automation: automacao, recent_sends: envios ?? [] }, { requestId });
}

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    template_name: z.string().trim().min(1).max(512),
    template_language: z.string().trim().min(2).max(16),
    variable_mapping: z.record(z.string(), variableSourceSchema),
    event_type_id: z.string().uuid().nullable(),
    timing_kind: z.enum(["day_of_8am", "days_before", "hours_before"]),
    timing_value: z.number().int().min(1).max(72).nullable(),
    confirm_button_text: z.string().trim().min(1).max(60).nullable(),
    decline_button_text: z.string().trim().min(1).max(60).nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Nada para alterar." })
  .refine((p) => (p.template_name === undefined) === (p.template_language === undefined), {
    message: "Modelo e idioma mudam juntos.",
    path: ["template_name"],
  });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", "Automação não encontrada.", 404, { requestId });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Dados da automação inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const patch = parsed.data;
  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  const { data: atual } = await admin
    .from("whatsapp_template_automations")
    .select(`id, status, trigger_kind, channel_session_id, ${COLUNAS_DA_CONFIGURACAO}`)
    .eq("id", id.data)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Automação não encontrada.", 404, { requestId });

  const antes: ConfiguracaoDaAutomacao = {
    name: atual.name as string,
    template_name: atual.template_name as string,
    template_language: atual.template_language as string,
    variable_mapping: (atual.variable_mapping ?? {}) as VariableMapping,
    event_type_id: (atual.event_type_id as string | null) ?? null,
    timing_kind: atual.timing_kind as ConfiguracaoDaAutomacao["timing_kind"],
    timing_value: (atual.timing_value as number | null) ?? null,
    confirm_button_text: (atual.confirm_button_text as string | null) ?? null,
    decline_button_text: (atual.decline_button_text as string | null) ?? null,
  };
  const depois: ConfiguracaoDaAutomacao = {
    ...antes,
    ...patch,
    variable_mapping: (patch.variable_mapping ?? antes.variable_mapping) as VariableMapping,
  };
  // "No dia, às 8h" não tem valor: trocar para ele limpa o número que sobrou do momento anterior.
  if (depois.timing_kind === "day_of_8am") depois.timing_value = null;

  if (!momentoValido(depois.timing_kind, depois.timing_value)) {
    return fail("invalid_request", MENSAGEM_MOMENTO_INVALIDO, 422, { requestId });
  }

  const alterados = camposAlterados(antes, depois);
  if (alterados.length === 0) return ok({ status: atual.status, campos_alterados: [] }, { requestId });

  const validacao = await validarConfiguracao(admin, orgId, atual.channel_session_id as string, depois, {
    exigirCanalNoAr: false,
  });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.mensagem, 422, { requestId, details: validacao.details });
  }

  if (mudouBotoes(antes, depois)) {
    const aguardando = await confirmacoesAguardandoResposta(admin, orgId, id.data, new Date());
    if (aguardando > 0) {
      return fail(
        "state_conflict",
        `Há ${aguardando} confirmação(ões) aguardando resposta do cliente. Trocar os botões agora faria essas respostas deixarem de confirmar o agendamento — troque depois que elas passarem.`,
        409,
        { requestId },
      );
    }
  }

  const ativa = atual.status === "active";
  if (ativa && mudouAlvoOuMomento(antes, depois)) {
    const conflito = await acharConflitoDeAtivacao(admin, orgId, {
      id: id.data,
      trigger_kind: atual.trigger_kind as string,
      event_type_id: depois.event_type_id,
      timing_kind: depois.timing_kind,
      timing_value: depois.timing_value,
    });
    if (conflito) {
      return fail("state_conflict", fraseDoConflito(Boolean(depois.event_type_id), conflito.name), 409, {
        requestId,
      });
    }
  }

  const { error } = await admin
    .from("whatsapp_template_automations")
    .update({
      name: depois.name,
      template_name: depois.template_name,
      template_language: depois.template_language,
      variable_mapping: depois.variable_mapping,
      event_type_id: depois.event_type_id,
      timing_kind: depois.timing_kind,
      timing_value: depois.timing_value,
      confirm_button_text: depois.confirm_button_text,
      decline_button_text: depois.decline_button_text,
    })
    .eq("id", id.data)
    .eq("organization_id", orgId);
  if (error) {
    // Corrida: outra ativação passou entre a conferência e o update — o índice único barrou.
    if (error.code === "23505") {
      return fail("state_conflict", fraseDoConflito(Boolean(depois.event_type_id), "outra automação"), 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "automation.updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "whatsapp_template_automation",
    resourceId: id.data,
    requestId,
    // Só os NOMES dos campos: o mapeamento pode carregar valores fixos e não precisa ir para o log.
    metadata: { actor_type: "user", campos: alterados, status: atual.status },
  });

  return ok({ status: atual.status, campos_alterados: alterados }, { requestId });
}
