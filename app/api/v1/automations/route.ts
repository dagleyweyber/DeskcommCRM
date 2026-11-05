/**
 * GET  /api/v1/automations — lista automações da org.
 * POST /api/v1/automations — cria em `draft`. Não dispara nada: só
 * `POST .../activate` muda isso — mesmo desenho em dois passos de
 * Campanhas (`app/api/v1/campaigns/route.ts`), pelo mesmo motivo: o
 * operador confere o que configurou antes de qualquer mensagem sair.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validarConfiguracao } from "@/lib/automations/configuracao";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";
import { createAdminClient } from "@/lib/supabase/admin";

import { variableSourceSchema } from "./_schema";

export const dynamic = "force-dynamic";

// Só o gatilho de agendamento existe hoje — `TRIGGER_RESOLVERS`
// (`lib/automations/triggers/index.ts`) é a fonte real; esta lista cresce
// junto quando um trigger_kind novo ganhar resolver.
const createAutomationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  trigger_kind: z.enum(["appointment_reminder"]),
  channel_session_id: z.string().uuid(),
  template_name: z.string().trim().min(1).max(512),
  template_language: z.string().trim().min(2).max(16),
  variable_mapping: z.record(z.string(), variableSourceSchema).default({}),
  // O SERVIÇO da Agenda a que esta automação responde. `null` = todos os serviços (o
  // comportamento de sempre). Uma automação ativa por serviço: ver migration 0199.
  event_type_id: z.string().uuid().nullable().default(null),
  // QUANDO enviar (migration 0201). Default = o comportamento de sempre.
  timing_kind: z.enum(["day_of_8am", "days_before", "hours_before"]).default("day_of_8am"),
  timing_value: z.number().int().min(1).max(72).nullable().default(null),
  // QUAL botão do modelo confirma/desmarca — preenchido = automação de confirmação.
  confirm_button_text: z.string().trim().min(1).max(60).nullable().default(null),
  decline_button_text: z.string().trim().min(1).max(60).nullable().default(null),
})
  .refine(
    (a) =>
      (a.timing_kind === "day_of_8am" && a.timing_value === null) ||
      (a.timing_kind === "days_before" && a.timing_value !== null && a.timing_value <= 7) ||
      (a.timing_kind === "hours_before" && a.timing_value !== null),
    { message: "Momento de envio inválido: 1 a 7 dias antes, ou 1 a 72 horas antes.", path: ["timing_value"] },
  );

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("whatsapp_template_automations")
    .select(
      "id, name, trigger_kind, status, template_name, template_language, event_type_id, event_type:calendar_event_types(name), timing_kind, timing_value, confirm_button_text, decline_button_text, created_at, updated_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok({ automations: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const parsed = createAutomationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Dados da automação inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const admin = createAdminClient();

  // Mesmas conferências da EDIÇÃO (`lib/automations/configuracao.ts`): o canal precisa ser desta
  // org e estar de pé, o modelo APROVADO, o serviço ativo, os botões existentes e toda variável
  // com origem. Automação que falha numa delas nasce condenada a nunca mandar nada.
  const validacao = await validarConfiguracao(
    admin,
    authz.org.orgId,
    input.channel_session_id,
    { ...input, variable_mapping: input.variable_mapping as VariableMapping },
    { exigirCanalNoAr: true },
  );
  if (!validacao.ok) {
    return fail("invalid_request", validacao.mensagem, 422, { requestId, details: validacao.details });
  }

  const { data: automacao, error: erroCriar } = await admin
    .from("whatsapp_template_automations")
    .insert({
      organization_id: authz.org.orgId,
      name: input.name,
      trigger_kind: input.trigger_kind,
      channel_session_id: input.channel_session_id,
      template_name: input.template_name,
      template_language: input.template_language,
      variable_mapping: input.variable_mapping,
      event_type_id: input.event_type_id,
      timing_kind: input.timing_kind,
      timing_value: input.timing_kind === "day_of_8am" ? null : input.timing_value,
      confirm_button_text: input.confirm_button_text,
      decline_button_text: input.decline_button_text,
      status: "draft",
      created_by: authz.user.id,
    })
    .select("id, name, trigger_kind, status")
    .single();

  if (erroCriar || !automacao) {
    return fail("internal_error", erroCriar?.message ?? "Falha ao criar a automação.", 500, {
      requestId,
    });
  }

  void audit({
    action: "automation.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_template_automation",
    resourceId: automacao.id,
    requestId,
    metadata: { trigger_kind: input.trigger_kind, template_name: input.template_name },
  });

  return ok(automacao, { status: 201, requestId });
}
