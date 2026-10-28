/**
 * GET /api/v1/leads/[id]/attribution
 *
 * De onde o lead veio: os pontos de contato (`lead_touchpoints`, migration 0202) com
 * os nomes de campanha / conjunto / anúncio resolvidos. Alimenta o bloco "Origem do
 * anúncio" do dossiê do lead.
 *
 * Tudo pela RLS do caller (cliente com cookie): o lead prova a organização, e as duas
 * tabelas lidas têm policy de leitura por membro da organização.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  montaAtribuicao,
  type HierarquiaDaMeta,
  type LinhaDoPontoDeContato,
} from "@/lib/atribuicao/visao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const COLUNAS =
  "id, canal, via, occurred_at, click_id_type, click_id, utm_source, utm_medium, utm_campaign, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, keyword, landing_url, extras";

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Negócio não encontrado.", 404, { requestId });
  const organizationId = (lead as { organization_id: string }).organization_id;

  const { data: linhas, error } = await supabase
    .from("lead_touchpoints")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: true })
    .limit(50);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const pontos = (linhas ?? []) as LinhaDoPontoDeContato[];
  const anunciosDaMeta = [
    ...new Set(pontos.filter((p) => p.canal === "meta_ads" && p.ad_id).map((p) => p.ad_id as string)),
  ];

  let hierarquias: HierarquiaDaMeta[] = [];
  if (anunciosDaMeta.length > 0) {
    const { data } = await supabase
      .from("meta_ads_ad_metadata")
      .select("ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name")
      .eq("organization_id", organizationId)
      .in("ad_id", anunciosDaMeta);
    // Sem nome resolvido (sem token de leitura, ou falha da API) o bloco ainda
    // mostra o id e o que veio na URL — não é motivo para derrubar a resposta.
    hierarquias = (data ?? []) as HierarquiaDaMeta[];
  }

  return ok(montaAtribuicao(pontos, hierarquias), { requestId });
}
