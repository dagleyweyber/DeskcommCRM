import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function makeReq(plan: unknown) {
  return new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}/plan`, {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
}

function makeAdminStub(org: { id: string; slug: string; settings: unknown } | null) {
  const updateCalls: unknown[] = [];
  const insertCalls: { table: string; row: unknown }[] = [];

  const orgBuilder = {
    select: () => orgBuilder,
    eq: () => orgBuilder,
    maybeSingle: async () => ({ data: org, error: null }),
    update: (row: unknown) => {
      updateCalls.push(row);
      return {
        eq: async () => ({ error: null }),
      };
    },
  };

  return {
    stub: {
      from: (table: string) => {
        if (table === "organizations") return orgBuilder;
        return {
          insert: (row: unknown) => {
            insertCalls.push({ table, row });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
    updateCalls,
    insertCalls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("POST /api/v1/admin/tenants/[id]/plan", () => {
  it("troca o plano e PRESERVA as outras chaves de settings — não sobrescreve o jsonb inteiro", async () => {
    const { stub, updateCalls } = makeAdminStub({
      id: ORG_ID,
      slug: "org",
      settings: { plan: "standard", feature_flag_x: true },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const res = await POST(makeReq("enterprise"), { params: Promise.resolve({ id: ORG_ID }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { plan: string; changed: boolean } };
    expect(body.data).toEqual({ id: ORG_ID, plan: "enterprise", changed: true });
    expect(updateCalls[0]).toMatchObject({
      settings: { plan: "enterprise", feature_flag_x: true },
    });
  });

  it("plano igual ao atual devolve changed=false sem tentar update", async () => {
    const { stub, updateCalls } = makeAdminStub({
      id: ORG_ID,
      slug: "org",
      settings: { plan: "pro" },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const res = await POST(makeReq("pro"), { params: Promise.resolve({ id: ORG_ID }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { changed: boolean } };
    expect(body.data.changed).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it("plano fora do vocabulário é rejeitado com validation_failed", async () => {
    const { stub } = makeAdminStub({ id: ORG_ID, slug: "org", settings: {} });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const res = await POST(makeReq("platinum"), { params: Promise.resolve({ id: ORG_ID }) });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("tenant inexistente devolve not_found", async () => {
    const { stub } = makeAdminStub(null);
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const res = await POST(makeReq("pro"), { params: Promise.resolve({ id: ORG_ID }) });

    expect(res.status).toBe(404);
  });

  it("quem não é platform admin recebe forbidden", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("not admin"));
    const { stub } = makeAdminStub({ id: ORG_ID, slug: "org", settings: {} });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const res = await POST(makeReq("pro"), { params: Promise.resolve({ id: ORG_ID }) });

    expect(res.status).toBe(403);
  });
});
