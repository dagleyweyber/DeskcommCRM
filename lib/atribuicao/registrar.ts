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
  // Uma linha por vez (são no máximo duas: primeiro e último toque). Mantém o
  // caminho igual ao do adaptador dos testes de banco, que só insere linha única —
  // assim o webhook e o nascimento do lead exercitam esta gravação de verdade lá.
  let gravados = 0;
  for (const ponto of pontos) {
    try {
      const { error } = await db.from("lead_touchpoints").insert(linhaDoPontoDeContato(ponto, ids));
      if (error) throw new Error(error.message);
      gravados += 1;
    } catch (err) {
      logger.warn("atribuicao: falha ao gravar ponto de contato", {
        organization_id: ids.organizationId,
        lead_id: ids.leadId,
        erro: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  return { gravados };
}
