/**
 * GET   /api/v1/integrations/belle/servicos — os tipos de serviço do Belle que já
 *       apareceram e a qual serviço da Agenda cada um está ligado (manager+). Para
 *       o tipo ainda não ligado, uma SUGESTÃO pelo nome — só sugestão: ligar é
 *       decisão de quem configura, porque o serviço escolhe o modelo de WhatsApp
 *       que a paciente recebe.
 * PATCH /api/v1/integrations/belle/servicos — liga (ou desliga, com null) um tipo
 *       a um serviço (admin) e corrige os agendamentos JÁ importados desse tipo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { sugerirServico, type ServicoDaAgenda } from "@/lib/agenda-externa/belle/traduzir";
import { PROVEDOR } from "@/lib/agenda-externa/sincronizar";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  external_key: z.string().trim().min(1).max(200),
  event_type_id: z.string().uuid().nullable(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;
  const supabase = await createClient();

  const { data: integ } = await supabase
    .from("calendar_integrations_safe")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (!integ) return ok({ tipos: [], servicos: [] }, { requestId });

  const [{ data: links, error }, { data: servicos }] = await Promise.all([
    supabase
      .from("calendar_integration_service_links")
      .select("external_key, external_label, event_type_id, last_seen_at")
      .eq("organization_id", authz.org.orgId)
      .eq("integration_id", integ.id)
      .order("external_label"),
    supabase
      .from("calendar_event_types")
      .select("id, name, is_active")
      .eq("organization_id", authz.org.orgId)
      .order("name"),
  ]);
  if (error) return fail("internal_error", "Erro ao ler os tipos de serviço do Belle.", 500, { requestId });

  const lista = (servicos ?? []) as ServicoDaAgenda[];
  const tipos = ((links ?? []) as { external_key: string; external_label: string; event_type_id: string | null; last_seen_at: string }[]).map(
    (l) => ({ ...l, sugestao: l.event_type_id ? null : sugerirServico(l.external_label, lista) }),
  );
  return ok({ tipos, servicos: lista }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  const { external_key, event_type_id } = parsed.data;

  const admin = createAdminClient();
  if (event_type_id) {
    // O serviço tem de ser DESTA organização — a FK só garante que ele existe.
    const { data: servico } = await admin
      .from("calendar_event_types")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", event_type_id)
      .maybeSingle();
    if (!servico) return fail("validation_failed", "Serviço não encontrado nesta conta.", 422, { requestId });
  }

  const { data: link, error } = await admin
    .from("calendar_integration_service_links")
    .update({ event_type_id })
    .eq("organization_id", orgId)
    .eq("external_key", external_key)
    .select("id, external_label")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao salvar a ligação.", 500, { requestId });
  if (!link) return fail("not_found", "Tipo de serviço não encontrado.", 404, { requestId });

  // Os já importados desse tipo passam a ter o serviço — inclusive os de hoje,
  // para a automação do serviço alcançá-los a tempo.
  const { data: corrigidos } = await admin
    .from("calendar_appointments")
    .update({ event_type_id })
    .eq("organization_id", orgId)
    .eq("external_provider", PROVEDOR)
    .eq("external_service_key", external_key)
    .select("id");

  await audit({
    action: "calendar_integration.service_linked",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "calendar_integration_service_links",
    resourceId: link.id as string,
    requestId,
    metadata: { external_key, tipo: link.external_label, event_type_id, agendamentos_corrigidos: corrigidos?.length ?? 0 },
  });

  return ok({ external_key, event_type_id, agendamentos_corrigidos: corrigidos?.length ?? 0 }, { requestId });
}
