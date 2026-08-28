/**
 * Envio de verdade pro Meta Conversions API — resolve credencial, monta o
 * payload (via `capi.ts`, puro) e faz o POST.
 *
 * Sem anti-SSRF (`assertSafeOutboundUrl`, usado por `call-webhook.ts`): lá o
 * destino é uma URL que o TENANT configura; aqui é fixo
 * (`graph.facebook.com`), não há URL de terceiro pra validar.
 *
 * `fetchImpl` é injetável só pra teste (mockar a Graph API sem bater na
 * Meta de verdade) — em produção sempre usa o `fetch` global.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCapiPayload, type CapiPayloadInput } from "@/lib/meta-ads/capi";
import { resolveMetaAdsCredentials } from "@/lib/meta-ads/credentials";

const GRAPH_API_VERSION = "v21.0";
const TIMEOUT_MS = 10_000;

export interface SendMetaCapiResult {
  status: "sent" | "failed" | "skipped";
  error?: string;
}

export async function sendMetaCapiEvent(
  admin: SupabaseClient,
  organizationId: string,
  input: CapiPayloadInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SendMetaCapiResult> {
  const creds = await resolveMetaAdsCredentials(admin, organizationId);
  if (!creds) return { status: "skipped", error: "no_credentials" };

  // Page ID do criativo (cache da Fase E2, `lib/meta-ads/ad-hierarchy.ts`) —
  // sem ele a Meta rejeita todo evento `business_messaging` (subcode
  // 2804116). Só consulta quando há `ad_id`: a maioria dos envios (website/
  // system_generated) nem usa esse campo.
  const adId = (input.sourceMetadata as Record<string, unknown> | null | undefined)?.ad_id;
  let pageId: string | null = null;
  if (typeof adId === "string" && adId) {
    const { data } = await admin
      .from("meta_ads_ad_metadata")
      .select("page_id")
      .eq("organization_id", organizationId)
      .eq("ad_id", adId)
      .maybeSingle();
    pageId = (data?.page_id as string | null) ?? null;
  }

  const payload = buildCapiPayload({ ...input, pageId });
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(creds.datasetId)}/events?access_token=${encodeURIComponent(creds.accessToken)}`;

  try {
    // redirect: "manual" — mesmo motivo de call-webhook.ts: nunca seguir 3xx
    // automaticamente, mesmo que aqui o destino não seja configurável pelo
    // tenant (defesa em profundidade barata).
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [payload] }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { status: "sent" };
    const text = await res.text().catch(() => "");
    return { status: "failed", error: `http_${res.status}: ${text.slice(0, 300)}` };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
