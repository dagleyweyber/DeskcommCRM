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
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const variableSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("contact_name") }),
  z.object({ kind: z.literal("contact_first_name") }),
  z.object({ kind: z.literal("appointment_date") }),
  z.object({ kind: z.literal("appointment_time") }),
]);

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
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_template_automations" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("whatsapp_template_automations")
    .select(
      "id, name, trigger_kind, status, template_name, template_language, event_type_id, event_type:calendar_event_types(name), created_at, updated_at",
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

  // Mesma validação de Campanhas — o canal precisa ser desta org e estar
  // de pé, o template precisa estar APROVADO. Automação sem os dois nasce
  // condenada a nunca mandar nada.
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, status")
    .eq("id", input.channel_session_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!sessao) return fail("invalid_request", "Canal não encontrado nesta organização.", 422, { requestId });
  if (sessao.status !== "WORKING") {
    return fail("invalid_request", "O canal escolhido não está conectado.", 422, { requestId });
  }

  const { data: template } = await admin
    .from("meta_templates")
    .select("status, components, parameter_format")
    .eq("organization_id", authz.org.orgId)
    .eq("channel_session_id", input.channel_session_id)
    .eq("name", input.template_name)
    .eq("language", input.template_language)
    .maybeSingle();
  if (!template || template.status !== "APPROVED") {
    return fail(
      "invalid_request",
      "Este modelo não está aprovado para este canal — sincronize em Conexões antes de criar a automação.",
      422,
      { requestId },
    );
  }

  // O serviço precisa ser desta organização e estar ativo na Agenda: uma automação presa a
  // um serviço que não existe nunca dispararia, e em silêncio.
  if (input.event_type_id) {
    const { data: servico } = await admin
      .from("calendar_event_types")
      .select("id, is_active")
      .eq("id", input.event_type_id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (!servico || servico.is_active === false) {
      return fail("invalid_request", "Serviço não encontrado na Agenda desta organização.", 422, { requestId });
    }
  }

  // Toda variável do modelo precisa de uma origem (mesma regra de Campanhas): sem isso toda
  // ocorrência falharia com `template_missing_values` no primeiro envio.
  const faltando = valoresSemFonte(
    {
      name: input.template_name,
      language: input.template_language,
      parameter_format: template.parameter_format ?? undefined,
      components: template.components as Definicao["components"],
    },
    input.variable_mapping as VariableMapping,
  );
  if (faltando.length > 0) {
    return fail("invalid_request", fraseDosValoresSemFonte(faltando), 422, {
      requestId,
      details: { variaveis_sem_origem: faltando.map((f) => f.rotulo) },
    });
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
