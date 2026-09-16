import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyImpersonateCookie, IMPERSONATE_COOKIE_NAME } from "@/lib/impersonate/cookie";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

/**
 * resolveActiveOrg — o banner de impersonate dizia "atuando como Tenant X"
 * mas a org ativa REAL continuava sendo a do próprio admin de plataforma
 * (ele não é membro de `user_organizations` do tenant do cliente), então
 * inbox/kanban/toda rota de API mostravam os dados errados. RLS já concede
 * acesso total a `fn_is_platform_admin()` — só faltava esta função ler o
 * cookie de impersonate em vez de ignorá-lo.
 */

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name) } : undefined),
  }),
}));
vi.mock("@/lib/impersonate/cookie", async () => {
  const actual = await vi.importActual<typeof import("@/lib/impersonate/cookie")>(
    "@/lib/impersonate/cookie",
  );
  return { ...actual, verifyImpersonateCookie: vi.fn() };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const PLATFORM_ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OWN_ORG_ID = "33333333-3333-4333-8333-333333333333";

const PLATFORM_ADMIN: AuthUser = {
  id: PLATFORM_ADMIN_ID,
  email: "dagley.weyber@adsprocompany.com",
  full_name: "Dagley Weyber",
  avatar_url: null,
  is_platform_admin: true,
  organizations: [
    {
      organization_id: OWN_ORG_ID,
      organization_name: "Ads Pro Company",
      role: "admin",
      organization_status: "active",
    },
  ],
};

function adminStubComOrg(displayName: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: TENANT_ID, display_name: displayName }, error: null }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  vi.mocked(createAdminClient).mockReturnValue(adminStubComOrg("B'Laser Caruaru") as never);
});

describe("resolveActiveOrg — impersonate (S-11.07)", () => {
  it("cookie de impersonate válido faz a org ativa virar a do tenant, não a do admin", async () => {
    cookieStore.set(IMPERSONATE_COOKIE_NAME, "token-valido");
    vi.mocked(verifyImpersonateCookie).mockReturnValue({
      valid: true,
      payload: { tenantId: TENANT_ID, platformAdminId: PLATFORM_ADMIN_ID, exp: 9999999999 },
    });

    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(PLATFORM_ADMIN);

    expect(org).toEqual({
      orgId: TENANT_ID,
      name: "B'Laser Caruaru",
      role: "admin",
      viaImpersonate: true,
    });
  });

  it("sem cookie de impersonate, cai pra própria org do admin (comportamento normal preservado)", async () => {
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(PLATFORM_ADMIN);

    expect(org).toEqual({ orgId: OWN_ORG_ID, name: "Ads Pro Company", role: "admin" });
  });

  it("cookie inválido/expirado é ignorado — não vaza acesso a tenant nenhum", async () => {
    cookieStore.set(IMPERSONATE_COOKIE_NAME, "token-forjado");
    vi.mocked(verifyImpersonateCookie).mockReturnValue({ valid: false, reason: "expired" });

    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(PLATFORM_ADMIN);

    expect(org).toEqual({ orgId: OWN_ORG_ID, name: "Ads Pro Company", role: "admin" });
  });

  it("cookie com platformAdminId de OUTRO admin é ignorado (defesa em profundidade)", async () => {
    cookieStore.set(IMPERSONATE_COOKIE_NAME, "token-de-outro-admin");
    vi.mocked(verifyImpersonateCookie).mockReturnValue({
      valid: true,
      payload: { tenantId: TENANT_ID, platformAdminId: "outro-admin-id", exp: 9999999999 },
    });

    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(PLATFORM_ADMIN);

    expect(org).toEqual({ orgId: OWN_ORG_ID, name: "Ads Pro Company", role: "admin" });
  });

  it("usuário comum (não platform admin) nunca consulta o cookie de impersonate", async () => {
    cookieStore.set(IMPERSONATE_COOKIE_NAME, "token-qualquer");
    const usuarioComum: AuthUser = { ...PLATFORM_ADMIN, is_platform_admin: false };

    const { resolveActiveOrg } = await import("./server");
    await resolveActiveOrg(usuarioComum);

    expect(verifyImpersonateCookie).not.toHaveBeenCalled();
  });
});

/**
 * Achado ao vivo (RevitaFio Mossoró, 2026-09-16): a atendente tinha DUAS
 * orgs — a duplicata criada por engano no cadastro (suspensa no mesmo dia)
 * e a de verdade (ativa). Sem cookie de org ativa (primeiro acesso pela
 * tela, não por troca explícita), a escolha caía na primeira linha que
 * `user_organizations` devolvesse — sem `ORDER BY`, podia ser a suspensa —
 * e ela via "conta suspensa" com acesso perfeitamente válido do lado.
 */
describe("resolveActiveOrg — prefere org ATIVA quando o usuário tem mais de uma", () => {
  const SUSPENSA_ID = "44444444-4444-4444-8444-444444444444";
  const ATIVA_ID = "55555555-5555-4555-8555-555555555555";
  const USUARIO_COM_DUAS_ORGS = (ordem: ["suspensa" | "ativa", "suspensa" | "ativa"]): AuthUser => {
    const suspensa = {
      organization_id: SUSPENSA_ID,
      organization_name: "Revitafio Mossoró (duplicata)",
      role: "admin" as const,
      organization_status: "suspended",
    };
    const ativa = {
      organization_id: ATIVA_ID,
      organization_name: "RevitaFio Mossoro",
      role: "admin" as const,
      organization_status: "active",
    };
    const mapa = { suspensa, ativa };
    return { ...PLATFORM_ADMIN, is_platform_admin: false, organizations: [mapa[ordem[0]], mapa[ordem[1]]] };
  };

  it("⭐ sem cookie, suspensa vindo PRIMEIRO — ainda assim resolve pra ativa", async () => {
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(USUARIO_COM_DUAS_ORGS(["suspensa", "ativa"]));
    expect(org).toEqual({ orgId: ATIVA_ID, name: "RevitaFio Mossoro", role: "admin" });
  });

  it("sem cookie, ativa vindo primeiro — comportamento inalterado", async () => {
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(USUARIO_COM_DUAS_ORGS(["ativa", "suspensa"]));
    expect(org).toEqual({ orgId: ATIVA_ID, name: "RevitaFio Mossoro", role: "admin" });
  });

  it("⭐ cookie aponta pra org que virou suspensa DEPOIS — não trava, cai pra ativa", async () => {
    cookieStore.set("active_org", SUSPENSA_ID);
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(USUARIO_COM_DUAS_ORGS(["suspensa", "ativa"]));
    expect(org).toEqual({ orgId: ATIVA_ID, name: "RevitaFio Mossoro", role: "admin" });
  });

  it("cookie aponta pra org ativa — respeita a escolha explícita normalmente", async () => {
    cookieStore.set("active_org", ATIVA_ID);
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(USUARIO_COM_DUAS_ORGS(["suspensa", "ativa"]));
    expect(org).toEqual({ orgId: ATIVA_ID, name: "RevitaFio Mossoro", role: "admin" });
  });

  it("única org é suspensa — continua mostrando a página de conta suspensa (não há pra onde cair)", async () => {
    const soSuspensa: AuthUser = {
      ...PLATFORM_ADMIN,
      is_platform_admin: false,
      organizations: [
        {
          organization_id: SUSPENSA_ID,
          organization_name: "Revitafio Mossoró (duplicata)",
          role: "admin",
          organization_status: "suspended",
        },
      ],
    };
    const { resolveActiveOrg } = await import("./server");
    const org = await resolveActiveOrg(soSuspensa);
    expect(org).toEqual({ orgId: SUSPENSA_ID, name: "Revitafio Mossoró (duplicata)", role: "admin" });
  });
});
