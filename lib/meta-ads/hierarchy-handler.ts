/**
 * `lead.created` → resolve e cacheia campanha/conjunto do anúncio, se houver
 * (Fase E2).
 *
 * Handler INDEPENDENTE dos outros que já escutam `lead.created` — convive
 * sem conflito, mesmo mecanismo de `metaCapiPurchaseHandler` (Fase C1) no
 * evento `lead.won`: o dispatcher filtra cada handler pela própria `key` em
 * `event_log.consumed_by`.
 *
 * Nunca chama a Graph API no caminho do webhook — só reage DEPOIS que o lead
 * já nasceu, e sai rápido (sem `ad_id`, sem token de leitura configurado, ou
 * `ad_id` já cacheado) na maioria das vezes. Cache é PERMANENTE por
 * `(organization_id, ad_id)`: nome de campanha não muda com frequência que
 * justifique refetch a cada lead novo do mesmo anúncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { resolveMetaAdsReadToken } from "@/lib/meta-ads/credentials";
import { resolveAdHierarchy } from "@/lib/meta-ads/ad-hierarchy";
import { logger } from "@/lib/logger";

export const META_ADS_HIERARCHY_CONSUMER_KEY = "meta-ads-resolve-hierarchy";

export async function handleLeadCreatedForAdHierarchy(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("source_metadata")
    .eq("id", row.entity_id)
    .maybeSingle();

  const adId = (lead?.source_metadata as Record<string, unknown> | null)?.ad_id as string | undefined;
  if (!adId) {
    return { consumer_key: META_ADS_HIERARCHY_CONSUMER_KEY, status: "skipped", detail: "no_ad_id" };
  }

  const { data: cached } = await admin
    .from("meta_ads_ad_metadata")
    .select("ad_id")
    .eq("organization_id", row.organization_id)
    .eq("ad_id", adId)
    .maybeSingle();
  if (cached) {
    return { consumer_key: META_ADS_HIERARCHY_CONSUMER_KEY, status: "skipped", detail: "already_cached" };
  }

  const token = await resolveMetaAdsReadToken(admin, row.organization_id);
  if (!token) {
    // Recurso opcional não configurado — estado normal, não é erro.
    return { consumer_key: META_ADS_HIERARCHY_CONSUMER_KEY, status: "skipped", detail: "no_read_token" };
  }

  const result = await resolveAdHierarchy(token, adId);

  const { error } = await admin.from("meta_ads_ad_metadata").upsert(
    {
      organization_id: row.organization_id,
      ad_id: adId,
      ad_name: result.hierarchy?.adName ?? null,
      adset_id: result.hierarchy?.adsetId ?? null,
      adset_name: result.hierarchy?.adsetName ?? null,
      campaign_id: result.hierarchy?.campaignId ?? null,
      campaign_name: result.hierarchy?.campaignName ?? null,
      page_id: result.hierarchy?.pageId ?? null,
      last_error: result.status === "failed" ? (result.error ?? "erro desconhecido") : null,
    },
    { onConflict: "organization_id,ad_id" },
  );
  if (error) {
    logger.warn("[meta-ads] falha ao gravar meta_ads_ad_metadata", {
      organization_id: row.organization_id,
      ad_id: adId,
      error: error.message,
    });
  }

  if (result.status === "failed") {
    logger.warn("[meta-ads] resolução de hierarquia de anúncio falhou", {
      organization_id: row.organization_id,
      ad_id: adId,
      error: result.error,
    });
  }

  return { consumer_key: META_ADS_HIERARCHY_CONSUMER_KEY, status: "ok" };
}

export const metaAdsHierarchyHandler: EventHandler = {
  key: META_ADS_HIERARCHY_CONSUMER_KEY,
  events: ["lead.created"],
  async handle(row) {
    return handleLeadCreatedForAdHierarchy(createAdminClient(), row);
  },
};
