/**
 * GET /api/v1/pipelines/[id]/service-options — lista de serviços/produtos
 * configurada em `crm_pipelines.settings.service_options` (tela de
 * Configurações › Funis, admin+).
 *
 * Piso `agent` (não `manager`, como o resto de /api/v1/pipelines): quem
 * PREENCHE o "Produto de interesse" no lead (LeadFieldsForm) é o mesmo agent
 * que já vê/edita o lead — gatear essa leitura em manager quebraria o select
 * pra metade do time sem motivo, já que a rota devolve só a lista de opções,
 * nada do resto da configuração do funil (vocabulary/fields/lost_reasons).
 */
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const { id: pipelineId } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_pipelines")
    .select("settings")
    .eq("id", pipelineId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Funil não encontrado.", 404, { requestId });

  const raw = (data.settings as { service_options?: unknown } | null)?.service_options;
  const service_options = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];

  return ok({ service_options }, { requestId });
}
