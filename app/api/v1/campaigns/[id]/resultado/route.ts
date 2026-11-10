/**
 * GET /api/v1/campaigns/[id]/resultado — o painel de UMA campanha: aceitas pela Meta,
 * entregues, lidas, respostas e saídas (até 72 h depois do envio), cliques de pessoas no
 * botão e falhas por código, com a explicação em português de cada código conhecido.
 *
 * A contagem é do banco (`fn_resultado_da_campanha`, migration 0218), numa ida só: ler os
 * destinatários aqui passaria pelo corte de 1.000 linhas do PostgREST.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resultadoDaCampanha } from "@/lib/campaigns/freios";
import { explicacaoDoCodigo } from "@/lib/messaging/motivo-da-falha";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Códigos que não são da Meta, gravados pelo próprio CRM. */
const ROTULO_LOCAL: Record<string, string> = {
  modelo_nao_aprovado: "O modelo não estava aprovado na hora do envio.",
  outro: "Outro motivo (veja a conversa do contato).",
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: campanha } = await admin
    .from("whatsapp_campaigns")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });

  const resultado = await resultadoDaCampanha(admin, authz.org.orgId, id);
  if (!resultado) return fail("internal_error", "Não foi possível calcular o resultado agora.", 500, { requestId });

  const { data: links } = await admin
    .from("whatsapp_campaign_links")
    .select("cliques")
    .eq("organization_id", authz.org.orgId)
    .eq("campaign_id", id);
  const cliques = (links ?? []).length
    ? ((links ?? []) as Array<{ cliques: number }>).reduce((t, l) => t + l.cliques, 0)
    : null;

  const falhas = Object.entries(resultado.falhas_por_codigo)
    .map(([codigo, quantidade]) => ({
      codigo,
      quantidade,
      explicacao: ROTULO_LOCAL[codigo] ?? explicacaoDoCodigo(codigo) ?? `Código ${codigo} da Meta.`,
    }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return ok({ ...resultado, falhas_por_codigo: falhas, cliques }, { requestId });
}
