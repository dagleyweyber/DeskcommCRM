/**
 * POST /api/v1/admin/tenants/[id]/plan
 *
 * Troca o plano de um tenant já existente. Faltava por completo: o plano só
 * era gravado uma vez, na criação (`tenants/route.ts`), e a tela do tenant
 * (`TenantOverview`) só sabia mostrá-lo — nenhuma rota nem botão existia pra
 * mudar depois. `settings` é jsonb (sem CHECK no banco), então a mesclagem
 * PRESERVA as outras chaves — sobrescrever `settings` inteiro apagaria o que
 * mais estiver lá.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { tenantPlanSchema } from "@/lib/schemas/tenant-plan";

const bodySchema = z.object({ plan: tenantPlanSchema });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await req.json();
    body = bodySchema.parse(raw);
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, settings")
    .eq("id", tenantId)
    .maybeSingle();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const previousSettings = (org.settings as Record<string, unknown> | null) ?? {};
  const previousPlan = (previousSettings.plan as string | undefined) ?? null;

  if (previousPlan === body.plan) {
    return ok({ id: tenantId, plan: body.plan, changed: false }, { requestId });
  }

  const { error: updateError } = await admin
    .from("organizations")
    .update({
      settings: { ...previousSettings, plan: body.plan },
      updated_at: new Date().toISOString(),
    })
    .eq("id", tenantId);

  if (updateError) {
    return fail("internal_error", "Failed to update tenant plan", 500, { requestId });
  }

  void audit({
    action: "tenant.plan_changed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "organization",
    resourceId: tenantId,
    requestId,
    metadata: {
      tenant_id: tenantId,
      tenant_slug: org.slug,
      previous_plan: previousPlan,
      new_plan: body.plan,
    },
  });

  void admin.from("event_log").insert({
    organization_id: tenantId,
    entity_kind: "organization",
    entity_id: tenantId,
    event_type: "tenant.plan_changed",
    payload: {
      tenant_id: tenantId,
      previous_plan: previousPlan,
      new_plan: body.plan,
    },
  });

  return ok({ id: tenantId, plan: body.plan, changed: true }, { requestId });
}
