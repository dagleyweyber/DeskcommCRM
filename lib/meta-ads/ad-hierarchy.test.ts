import { describe, expect, it, vi } from "vitest";
import { resolveAdHierarchy } from "./ad-hierarchy";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("resolveAdHierarchy", () => {
  it("⭐ resposta OK com campanha, conjunto e page_id completos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        name: "Anúncio Botox",
        adset: { id: "999", name: "Conjunto Verão" },
        campaign: { id: "888", name: "Campanha Botox 2026" },
        creative: { object_story_spec: { page_id: "113751265048315" } },
      }),
    );
    const result = await resolveAdHierarchy("token-123", "120210000000000", { fetchImpl });
    expect(result).toEqual({
      status: "ok",
      hierarchy: {
        adName: "Anúncio Botox",
        adsetId: "999",
        adsetName: "Conjunto Verão",
        campaignId: "888",
        campaignName: "Campanha Botox 2026",
        pageId: "113751265048315",
      },
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain("120210000000000");
    expect(url).toContain("access_token=token-123");
    expect(url).toContain("creative");
  });

  it("campo faltando (ex: anúncio sem adset nem creative) vira null, não quebra", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ name: "Anúncio Solto" }));
    const result = await resolveAdHierarchy("token-123", "1", { fetchImpl });
    expect(result).toEqual({
      status: "ok",
      hierarchy: {
        adName: "Anúncio Solto",
        adsetId: null,
        adsetName: null,
        campaignId: null,
        campaignName: null,
        pageId: null,
      },
    });
  });

  it("⭐ erro HTTP (token sem permissão) vira failed com o corpo do erro", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: "(#200) Requires ads_read permission" } },
        400,
      ),
    );
    const result = await resolveAdHierarchy("token-sem-escopo", "1", { fetchImpl });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("http_400");
    expect(result.error).toContain("ads_read permission");
  });

  it("exceção de rede vira failed, não propaga", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await resolveAdHierarchy("token-123", "1", { fetchImpl });
    expect(result).toEqual({ status: "failed", error: "network down" });
  });

  it("resposta não-JSON vira failed sem lançar", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>erro</html>", { status: 500 }));
    const result = await resolveAdHierarchy("token-123", "1", { fetchImpl });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("http_500");
  });
});
