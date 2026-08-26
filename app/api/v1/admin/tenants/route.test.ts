import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";

/**
 * POST /api/v1/admin/tenants — `organizations.legal_name` é NOT NULL no
 * banco, mas o Zod da rota trata como opcional (razão social pode não estar
 * em mãos na hora de criar o tenant). O insert gravava `legal_name ?? null`
 * quando omitido — violava o NOT NULL e o admin via só "Failed to create
 * tenant" genérico, sem pista nenhuma. Correção: cai pro display_name, mesma
 * convenção do signup próprio (lib/auth/provision.ts).
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn() }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function makeAdminStub(insertSpy: (row: Record<string, unknown>) => void) {
  return {
    from: (table: string) => {
      if (table !== "organizations") throw new Error(`tabela não simulada: ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          insertSpy(row);
          return {
            select: () => ({
              single: async () => ({
                data: { id: "22222222-2222-4222-8222-222222222222", slug: row.slug, display_name: row.display_name },
                error: null,
              }),
            }),
          };
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID, email: "admin@adsprocompany.com" },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "email-1" });
});

describe("POST /api/v1/admin/tenants", () => {
  it("legal_name omitido cai pro display_name — não manda null pra coluna NOT NULL", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub((row) => {
        insertedRow = row;
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/admin/tenants", {
        method: "POST",
        body: JSON.stringify({
          display_name: "B'Laser Caruaru",
          slug: "b-laser-caruaru",
          plan: "enterprise",
          owner_email: "caruaru@clinicablaser.com.br",
        }),
      }),
    );

    expect(res.status).toBe(201);
    expect(insertedRow?.legal_name).toBe("B'Laser Caruaru");
  });

  it("legal_name informado é preservado (não sobrescrito pelo display_name)", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub((row) => {
        insertedRow = row;
      }) as never,
    );

    const { POST } = await import("./route");
    await POST(
      new NextRequest("http://localhost/api/v1/admin/tenants", {
        method: "POST",
        body: JSON.stringify({
          display_name: "B'Laser Caruaru",
          slug: "b-laser-caruaru",
          legal_name: "Maria da Silva LTDA",
          plan: "enterprise",
          owner_email: "caruaru@clinicablaser.com.br",
        }),
      }),
    );

    expect(insertedRow?.legal_name).toBe("Maria da Silva LTDA");
  });
});
