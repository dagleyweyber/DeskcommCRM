/**
 * Resolve as credenciais do Meta Ads de um tenant, já decifradas.
 *
 * `null` quando não há credencial conectada OU quando a decifra falha
 * (chave da GUC ausente, ciphertext malformado) — nunca lança. É o mesmo
 * contrato de `decryptWebhookSecret`: quem chama trata ausência como "o
 * recurso não está ativado", não como erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface MetaAdsCredentials {
  accessToken: string;
  datasetId: string;
}

export async function resolveMetaAdsCredentials(
  admin: SupabaseClient,
  organizationId: string,
): Promise<MetaAdsCredentials | null> {
  const { data: row } = await admin
    .from("tenant_meta_ads_credentials")
    .select("access_token_encrypted, dataset_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!row) return null;

  const accessToken = await decryptWebhookSecret(admin, row.access_token_encrypted as string);
  if (!accessToken) return null;

  return { accessToken, datasetId: row.dataset_id as string };
}
