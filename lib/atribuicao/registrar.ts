/**
 * Grava os pontos de contato de um lead em `lead_touchpoints` (migration 0202).
 *
 * Não lança, por desenho: atribuição DESCREVE de onde o lead veio — se a gravação
 * falhar, o lead tem de nascer mesmo assim (perder o lead para guardar a origem dele
 * seria trocar o principal pelo acessório). A falha vai para o log com o motivo, e o
 * lead continua com `source_metadata` como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { PontoDeContato } from "./ponto-de-contato";

export function linhaDoPontoDeContato(
  ponto: PontoDeContato,
  ids: { organizationId: string; leadId: string; contactId: string | null },
): Record<string, unknown> {
  return {
    organization_id: ids.organizationId,
    lead_id: ids.leadId,
    contact_id: ids.contactId,
    canal: ponto.canal,
    via: ponto.via,
    click_id_type: ponto.clickIdType,
    click_id: ponto.clickId,
    fbc: ponto.fbc,
    fbp: ponto.fbp,
    utm_source: ponto.utmSource,
    utm_medium: ponto.utmMedium,
    utm_campaign: ponto.utmCampaign,
    utm_content: ponto.utmContent,
    utm_term: ponto.utmTerm,
    campaign_id: ponto.campaignId,
    adset_id: ponto.adsetId,
    ad_id: ponto.adId,
    campaign_name: ponto.campaignName,
    adset_name: ponto.adsetName,
    ad_name: ponto.adName,
    keyword: ponto.keyword,
    landing_url: ponto.landingUrl,
    referrer: ponto.referrer,
    client_user_agent: ponto.clientUserAgent,
    extras: ponto.extras,
    ...(ponto.occurredAt ? { occurred_at: ponto.occurredAt } : {}),
  };
}

export async function registrarPontosDeContato(
  db: SupabaseClient,
  ids: { organizationId: string; leadId: string; contactId: string | null },
  pontos: readonly PontoDeContato[],
): Promise<{ gravados: number }> {
  if (pontos.length === 0) return { gravados: 0 };
  try {
    const { error } = await db
      .from("lead_touchpoints")
      .insert(pontos.map((p) => linhaDoPontoDeContato(p, ids)));
    if (error) {
      logger.warn("atribuicao: falha ao gravar ponto de contato", {
        organization_id: ids.organizationId,
        lead_id: ids.leadId,
        erro: error.message.slice(0, 200),
      });
      return { gravados: 0 };
    }
    return { gravados: pontos.length };
  } catch (err) {
    logger.warn("atribuicao: falha ao gravar ponto de contato", {
      organization_id: ids.organizationId,
      lead_id: ids.leadId,
      erro: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { gravados: 0 };
  }
}
