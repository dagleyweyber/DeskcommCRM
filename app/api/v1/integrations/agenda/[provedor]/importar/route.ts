/**
 * POST /api/v1/integrations/agenda/[provedor]/importar (admin) — traz para a Agenda o que
 * já estava marcado no sistema da clínica ANTES da conexão. Só Zandu: o Uno não tem
 * leitura de agenda na API (só o aviso).
 *
 * Uma vez por conexão basta; rodar de novo não duplica (casa pelo código do agendamento).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { clienteDoZandu, COLUNAS_INTEGRACAO } from "@/lib/agenda-externa/avisos";
import type { Integracao } from "@/lib/agenda-externa/sincronizar";
import { FalhaNoZandu, TokenZanduInvalido } from "@/lib/agenda-externa/zandu/api";
import { importarAgendaDoZandu } from "@/lib/agenda-externa/zandu/importar";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RouteCtx {
  params: Promise<{ provedor: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { provedor } = await ctx.params;
  if (provedor !== "zandu") return fail("not_found", "Importação disponível só para o Zandu.", 404, { requestId });
  const authz = await requireRole("admin", { requestId, resource: "calendar_integrations" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  // Service role: filtro de org manual, org vinda da sessão.
  const admin = createAdminClient();
  const { data } = await admin
    .from("calendar_integrations")
    .select(COLUNAS_INTEGRACAO)
    .eq("organization_id", orgId)
    .eq("provider", "zandu")
    .maybeSingle();
  const integ = data as Integracao | null;
  if (!integ) return fail("not_found", "Conecte o Zandu antes de importar.", 404, { requestId });

  try {
    const agora = new Date();
    const r = await importarAgendaDoZandu(admin, integ, await clienteDoZandu(admin, integ), { agora });
    await admin
      .from("calendar_integrations")
      .update({
        status: "healthy",
        last_error: null,
        last_sync_at: agora.toISOString(),
        last_sync_stats: r.contagem,
        initial_sync_done_at: agora.toISOString(),
      })
      .eq("id", integ.id)
      .eq("organization_id", orgId);
    await audit({
      action: "calendar_integration.imported",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "calendar_integrations",
      resourceId: integ.id,
      requestId,
      metadata: { provider: "zandu", pessoas: r.pessoas, agendamentos: r.agendamentos, incompleto: r.incompleto },
    });
    return ok(r, { requestId });
  } catch (err) {
    logger.error("[agenda-externa] importação do Zandu falhou", { organization_id: orgId, erro: String(err) });
    if (err instanceof TokenZanduInvalido) {
      return fail("validation_failed", "O Zandu recusou o token salvo. Cole um token novo.", 422, { requestId });
    }
    const motivo = err instanceof FalhaNoZandu ? err.message : "erro inesperado";
    return fail("upstream_unavailable", `Não foi possível importar agora (${motivo}). Tente de novo em instantes.`, 502, { requestId });
  }
}
