/**
 * GET  /api/v1/campaigns — lista campanhas da org, com progresso.
 * POST /api/v1/campaigns — cria em `draft`: resolve o público (snapshot,
 * uma vez), resolve as variáveis por destinatário, grava tudo. NÃO dispara
 * nada — só `POST .../start` muda isso (ver o cabeçalho da migration 0167
 * pra por quê o criar/iniciar é em dois passos).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { resolveAudience, type AudienceFilter } from "@/lib/campaigns/audience";
import { resolveValuesForRecipient, type VariableMapping } from "@/lib/messaging/variable-mapping";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const variableSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("contact_name") }),
  z.object({ kind: z.literal("contact_first_name") }),
]);

const audienceSchema: z.ZodType<AudienceFilter> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tag"), tag: z.string().trim().min(1).max(60) }),
  z.object({
    kind: z.literal("pipeline_stage"),
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid(),
  }),
  z.object({ kind: z.literal("all_contacts") }),
]);

const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  channel_session_id: z.string().uuid(),
  template_name: z.string().trim().min(1).max(512),
  template_language: z.string().trim().min(2).max(16),
  variable_mapping: z.record(z.string(), variableSourceSchema).default({}),
  audience: audienceSchema,
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("whatsapp_campaigns")
    .select(
      "id, name, status, template_name, template_language, total_recipients, sent_count, failed_count, created_at, started_at, completed_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok({ campaigns: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const parsed = createCampaignSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Dados da campanha inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const admin = createAdminClient();

  // O canal precisa ser desta org e estar de pé — sem isso a campanha
  // nasceria pra nunca conseguir mandar nada.
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

  // O template precisa estar APROVADO — sem isso todo destinatário nasceria
  // condenado a `failed` no primeiro tick do despachante.
  const { data: template } = await admin
    .from("meta_templates")
    .select("status")
    .eq("organization_id", authz.org.orgId)
    .eq("channel_session_id", input.channel_session_id)
    .eq("name", input.template_name)
    .eq("language", input.template_language)
    .maybeSingle();
  if (!template || template.status !== "APPROVED") {
    return fail(
      "invalid_request",
      "Este modelo não está aprovado para este canal — sincronize em Conexões antes de criar a campanha.",
      422,
      { requestId },
    );
  }

  const publico = await resolveAudience(admin, authz.org.orgId, input.audience);

  const { data: campanha, error: erroCriar } = await admin
    .from("whatsapp_campaigns")
    .insert({
      organization_id: authz.org.orgId,
      name: input.name,
      channel_session_id: input.channel_session_id,
      template_name: input.template_name,
      template_language: input.template_language,
      variable_mapping: input.variable_mapping,
      audience_filter: input.audience,
      status: "draft",
      total_recipients: publico.length,
      created_by: authz.user.id,
    })
    .select("id, name, status, total_recipients")
    .single();

  if (erroCriar || !campanha) {
    return fail("internal_error", erroCriar?.message ?? "Falha ao criar a campanha.", 500, {
      requestId,
    });
  }

  if (publico.length > 0) {
    const mapping = input.variable_mapping as VariableMapping;
    const linhas = publico.map((membro) => ({
      campaign_id: campanha.id,
      organization_id: authz.org.orgId,
      contact_id: membro.contactId,
      lead_id: membro.leadId,
      resolved_values: resolveValuesForRecipient(mapping, membro),
      status: "pending",
    }));
    const { error: erroDestinatarios } = await admin
      .from("whatsapp_campaign_recipients")
      .insert(linhas);
    if (erroDestinatarios) {
      return fail("internal_error", erroDestinatarios.message, 500, { requestId });
    }
  }

  void audit({
    action: "campaign.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: campanha.id,
    requestId,
    metadata: {
      template_name: input.template_name,
      audience: input.audience,
      total_recipients: publico.length,
    },
  });

  return ok(campanha, { status: 201, requestId });
}
