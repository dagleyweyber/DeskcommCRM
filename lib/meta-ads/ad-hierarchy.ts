/**
 * Resolve a hierarquia campanha/conjunto de um anúncio via Graph API
 * (Marketing API) — precisa de um token com `ads_read`/`ads_management`,
 * DIFERENTE do token de Conversions API da Fase C1 (esse só tem
 * `read_ads_dataset_quality`, confirmado ao vivo antes de desenhar a Fase E).
 *
 * `fetchImpl` é injetável só pra teste (mockar a Graph API sem bater na Meta
 * de verdade) — em produção sempre usa o `fetch` global. Mesmo padrão de
 * `lib/meta-ads/send.ts`.
 */
const GRAPH_API_VERSION = "v21.0";
const TIMEOUT_MS = 10_000;

export interface AdHierarchy {
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
}

export interface ResolveAdHierarchyResult {
  status: "ok" | "failed";
  hierarchy?: AdHierarchy;
  error?: string;
}

interface GraphAdResponse {
  name?: string;
  adset?: { id?: string; name?: string };
  campaign?: { id?: string; name?: string };
  error?: { message?: string };
}

export async function resolveAdHierarchy(
  accessToken: string,
  adId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ResolveAdHierarchyResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(adId)}` +
    `?fields=${encodeURIComponent("name,adset{id,name},campaign{id,name}")}` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  try {
    // redirect: "manual" — mesmo motivo de send.ts: destino fixo (graph.
    // facebook.com), não configurável pelo tenant, mas nunca seguir 3xx
    // automaticamente é defesa em profundidade barata.
    const res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text().catch(() => "");
    let body: GraphAdResponse | null = null;
    try {
      body = JSON.parse(text) as GraphAdResponse;
    } catch {
      body = null;
    }

    if (!res.ok || !body || body.error) {
      const msg = body?.error?.message ?? text;
      return { status: "failed", error: `http_${res.status}: ${msg.slice(0, 300)}` };
    }

    return {
      status: "ok",
      hierarchy: {
        adName: body.name ?? null,
        adsetId: body.adset?.id ?? null,
        adsetName: body.adset?.name ?? null,
        campaignId: body.campaign?.id ?? null,
        campaignName: body.campaign?.name ?? null,
      },
    };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
