/**
 * GET /api/v1/integrations/meta-ads/sends — conversões enviadas à Meta nos últimos
 * 30 dias: aceitas e recusadas por evento (lead único), com o motivo e o que fazer.
 *
 * Existe porque a conexão aparecia "Conectado" enquanto a maioria das vendas era
 * recusada (medido em 2026-10-28: B'laser Caruaru, 25 vendas nunca aceitas e 4
 * aceitas em 30 dias). Lê pela RLS do caller (`meta_capi_send_log_select`).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resumeEnvios, type LinhaDeEnvio } from "@/lib/meta-ads/resumo-de-envios";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DIAS = 30;

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads_credentials" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meta_capi_send_log")
    .select("lead_id, event_name, status, meta_error, created_at")
    .eq("organization_id", activeOrg.orgId)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return fail("internal_error", "Erro ao ler os envios ao Meta Ads.", 500, { requestId });

  return ok({ dias: DIAS, eventos: resumeEnvios((data ?? []) as LinhaDeEnvio[]) }, { requestId });
}
