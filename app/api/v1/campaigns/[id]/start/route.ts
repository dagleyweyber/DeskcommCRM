/**
 * POST /api/v1/campaigns/[id]/start — sai de `draft`/`paused` pra `queued`.
 * Não dispara nada aqui: o cron `campaign-dispatch` é quem manda a primeira
 * mensagem, no tick seguinte.
 *
 * Retomar uma campanha que PAROU SOZINHA (migration 0218):
 *   - modelo pausado ou desativado pela Meta → recusa: a Meta não entregaria, e a campanha
 *     pararia de novo no primeiro envio;
 *   - nota amarela/vermelha (modelo ou número) → quem retoma assume o risco: o motivo vai para
 *     `freios_dispensados` e o freio não para de novo pela mesma nota;
 *   - cobrança e saídas → `retomada_em` recomeça a medição do zero.
 * O motivo da pausa é limpo: a tela deixa de mostrá-lo como atual.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { MOTIVOS_DISPENSAVEIS, ehMotivoDePausa } from "@/lib/campaigns/motivos-de-pausa";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: campanha } = await admin
    .from("whatsapp_campaigns")
    .select("id, status, started_at, channel_session_id, template_name, template_language, pausa_motivo, freios_dispensados")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });
  if (campanha.status !== "draft" && campanha.status !== "paused") {
    return fail("invalid_request", `Não é possível iniciar uma campanha ${campanha.status}.`, 422, {
      requestId,
    });
  }

  // O modelo precisa estar aprovado AGORA — vale para iniciar e para retomar.
  const { data: modelo } = await admin
    .from("meta_templates")
    .select("status")
    .eq("organization_id", authz.org.orgId)
    .eq("channel_session_id", campanha.channel_session_id)
    .eq("name", campanha.template_name)
    .eq("language", campanha.template_language)
    .maybeSingle();
  if (modelo && modelo.status !== "APPROVED") {
    return fail(
      "invalid_request",
      `O modelo "${campanha.template_name}" está ${modelo.status} na Meta e não seria entregue. ` +
        "Aguarde ele voltar a ficar aprovado (sincronize em Conexões) ou crie a campanha com outro modelo.",
      422,
      { requestId },
    );
  }

  const motivo = ehMotivoDePausa(campanha.pausa_motivo) ? campanha.pausa_motivo : null;
  const dispensados = new Set<string>((campanha.freios_dispensados as string[] | null) ?? []);
  if (motivo && MOTIVOS_DISPENSAVEIS.includes(motivo)) dispensados.add(motivo);
  const retomando = campanha.status === "paused";

  const { error } = await admin
    .from("whatsapp_campaigns")
    .update({
      status: "queued",
      // `started_at` só na PRIMEIRA vez — retomar de `paused` não reinicia a
      // contagem de quando a campanha começou.
      ...(campanha.started_at ? {} : { started_at: new Date().toISOString() }),
      ...(retomando
        ? {
            pausa_motivo: null,
            pausa_detalhe: null,
            retomada_em: new Date().toISOString(),
            freios_dispensados: [...dispensados],
          }
        : {}),
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: retomando ? "campaign.resumed" : "campaign.started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_campaign",
    resourceId: id,
    requestId,
    metadata: retomando ? { motivo_da_pausa: motivo, freios_dispensados: [...dispensados] } : undefined,
  });

  return ok({ status: "queued" }, { requestId });
}
