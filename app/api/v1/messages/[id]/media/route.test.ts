/**
 * Achado ao vivo (RevitaFio Mossoró): esta rota gerava uma signed URL NOVA a
 * cada carregamento — o navegador nunca reaproveitava nada porque a URL de
 * destino mudava sempre. Resultado: egress do Storage crescendo sem limite
 * (estourou a cota da Supabase) e mídia recarregando do zero toda vez que uma
 * conversa já vista era reaberta. O conserto é o MESMO padrão já usado em
 * `app/api/v1/contacts/[id]/avatar/route.ts`: Cache-Control no redirect,
 * `private` (autorização é por sessão) e abaixo do TTL da signed URL (senão
 * o navegador reusaria um redirect pra um link já vencido).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER: AuthUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "atendente@invariant.test",
  full_name: null,
  avatar_url: null,
  is_platform_admin: false,
  organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent", organization_status: "active" }],
};

type Msg = { id: string; media_url: string | null; media_mime: string | null; media_storage_path: string | null; channel_session_id: string | null };

function stubUserClient(msg: Msg | null) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER.id } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: msg, error: null }),
          }),
        }),
      }),
    }),
  } as unknown;
}

function stubAdminClient(createSignedUrlSpy: ReturnType<typeof vi.fn>) {
  return {
    storage: {
      from: () => ({ createSignedUrl: createSignedUrlSpy }),
    },
  } as unknown;
}

function req(id: string): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new NextRequest(`http://localhost/api/v1/messages/${id}/media`),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(USER);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, name: "Org", role: "agent" });
});

describe("GET /api/v1/messages/[id]/media", () => {
  it("⭐ mídia persistida: 302 com Cache-Control private e max-age ABAIXO do TTL da signed URL", async () => {
    const msg: Msg = {
      id: "m1",
      media_url: null,
      media_mime: "image/jpeg",
      media_storage_path: "org/conv/foto.jpg",
      channel_session_id: null,
    };
    const signedUrl = "https://storage.example/whatsapp-media/org/conv/foto.jpg?token=abc";
    const createSignedUrlSpy = vi.fn(async () => ({ data: { signedUrl }, error: null }));
    vi.mocked(createClient).mockResolvedValue(stubUserClient(msg) as never);
    vi.mocked(createAdminClient).mockReturnValue(stubAdminClient(createSignedUrlSpy) as never);

    const { GET } = await import("./route");
    const { req: r, ctx } = req("m1");
    const res = await GET(r, ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(signedUrl);

    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toMatch(/^private, max-age=\d+$/);
    const maxAge = Number(cacheControl!.match(/max-age=(\d+)/)![1]);
    // TTL da signed URL é 3600 (const SIGNED_URL_TTL_S) — o cache do
    // navegador tem que expirar ANTES, senão ele reusaria um redirect pra
    // uma assinatura já vencida do outro lado.
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThan(3600);

    // createSignedUrl foi chamado com o TTL do servidor (3600), não o maxAge do cache.
    expect(createSignedUrlSpy).toHaveBeenCalledWith("org/conv/foto.jpg", 3600);
  });

  it("mensagem sem mídia nenhuma devolve 404, sem chamar o Storage", async () => {
    const msg: Msg = { id: "m2", media_url: null, media_mime: null, media_storage_path: null, channel_session_id: null };
    const createSignedUrlSpy = vi.fn();
    vi.mocked(createClient).mockResolvedValue(stubUserClient(msg) as never);
    vi.mocked(createAdminClient).mockReturnValue(stubAdminClient(createSignedUrlSpy) as never);

    const { GET } = await import("./route");
    const { req: r, ctx } = req("m2");
    const res = await GET(r, ctx);

    expect(res.status).toBe(404);
    expect(createSignedUrlSpy).not.toHaveBeenCalled();
  });

  it("sem organização ativa devolve 403, antes de tocar a mensagem", async () => {
    vi.mocked(resolveActiveOrg).mockResolvedValue(null);
    vi.mocked(createClient).mockResolvedValue(stubUserClient(null) as never);

    const { GET } = await import("./route");
    const { req: r, ctx } = req("m3");
    const res = await GET(r, ctx);

    expect(res.status).toBe(403);
  });
});
