import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Achado ao vivo (RevitaFio Mossoró): a org tem Meta Cloud API E WAHA
 * ligados ao mesmo tempo (migrando de canal). A consulta de sessão do cron
 * pegava `.limit(1)` SEM ordenar — quando a linha que veio primeiro era a
 * Meta Cloud API (que a própria Meta nunca expõe foto de perfil, é
 * limitação da plataforma, não bug daqui), NENHUM contato da org ganhava
 * foto, pra sempre — mesmo com a sessão WAHA, perfeitamente capaz, do lado.
 * Prova aqui: com as duas sessões WORKING e a incapaz vindo PRIMEIRO na
 * consulta, o cron ainda assim usa a capaz.
 */

const CONTATO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CAMINHO = `${ORG}/avatars/${CONTATO}.jpg`;

const updatesContacts: { patch: Record<string, unknown> }[] = [];
const uploads: string[] = [];
const chamadasFetchFoto: string[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider, waha_session_name, meta_phone_number_id, zernio_account_id",
  // meta_cloud NÃO sabe buscar foto (limitação real da plataforma da Meta);
  // waha sabe. É exatamente a diferença de capacidade que a rota precisa
  // respeitar ao escolher qual sessão usar.
  getAdapter: (provider: string) =>
    provider === "waha"
      ? {
          fetchProfilePictureUrl: async (input: { sessionRef: string }) => {
            chamadasFetchFoto.push(input.sessionRef);
            return "https://cdn.exemplo.invalid/foto.jpg";
          },
        }
      : {},
  resolveSessionRef: (s: { provider: string; waha_session_name?: string | null; meta_phone_number_id?: string | null }) =>
    s.provider === "waha" ? (s.waha_session_name ?? "") : (s.meta_phone_number_id ?? ""),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const dados =
        tabela === "contacts"
          ? [{ id: CONTATO, organization_id: ORG, wa_identity: "phone:+5511999990000", avatar_storage_path: null }]
          : // meta_cloud vem PRIMEIRO de propósito — é o cenário que reproduzia o bug.
            [
              { provider: "meta_cloud", waha_session_name: null, meta_phone_number_id: "1234567890" },
              { provider: "waha", waha_session_name: "sessao-waha-de-teste", meta_phone_number_id: null },
            ];
      const selectProxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
            }
            return () => selectProxy;
          },
        },
      );
      return {
        select: () => selectProxy,
        update: (patch: Record<string, unknown>) => {
          const updateProxy: Record<string, unknown> = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === "then") {
                  return (ok: (v: unknown) => unknown) => {
                    updatesContacts.push({ patch });
                    return Promise.resolve({ data: [{ id: CONTATO }], error: null }).then(ok);
                  };
                }
                if (prop === "select") {
                  return () => {
                    updatesContacts.push({ patch });
                    return Promise.resolve({ data: [{ id: CONTATO }], error: null });
                  };
                }
                return () => updateProxy;
              },
            },
          );
          return updateProxy;
        },
        upsert: async () => ({ error: null }),
      };
    },
    storage: {
      from: () => ({
        upload: async (caminho: string) => {
          uploads.push(caminho);
          return { error: null };
        },
      }),
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

beforeEach(() => {
  updatesContacts.length = 0;
  uploads.length = 0;
  chamadasFetchFoto.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

describe("cron de fotos de perfil — escolhe a sessão CAPAZ, não a primeira", () => {
  it("⭐ meta_cloud vem primeiro na consulta, mas o cron usa a sessão waha pra buscar a foto", async () => {
    const resposta = await chamar();
    expect(resposta.status).toBe(200);

    expect(chamadasFetchFoto).toEqual(["sessao-waha-de-teste"]);
    expect(uploads).toContain(CAMINHO);

    const carimbo = updatesContacts.find((u) => u.patch.avatar_storage_path === CAMINHO);
    expect(carimbo, "deveria ter gravado a foto encontrada via WAHA").toBeDefined();
  });
});
