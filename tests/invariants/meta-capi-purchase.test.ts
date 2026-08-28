import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { resolveMetaAdsCredentials } from "@/lib/meta-ads/credentials";
import { sendMetaCapiEvent } from "@/lib/meta-ads/send";
import { handleLeadWonForMetaCapi } from "@/lib/meta-ads/won-handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

import { pgComoSupabase } from "../pg-como-supabase";
import { sql, lastLine } from "./gov-helpers";

/**
 * Meta Ads, Fase C1 — credenciais por tenant + envio automático de
 * Purchase quando um lead vira "ganho".
 *
 * A GUC da chave de cifra é setada no DATABASE (não só na sessão) — mesmo
 * padrão de `webhooks-inbound.test.ts`: `pgComoSupabase` empresta
 * conexões de um `pg.Pool`, e `set_config(..., false)` sozinho (session-
 * level) não sobreviveria a uma conexão nova puxada do pool.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const GUC_KEY = "test-guc-key-0123456789abcdef0123456789abcdef";

const ORG_A = "7e7a7e70-0000-4000-8000-000000000001";
const ORG_B = "7e7a7e70-0000-4000-8000-000000000002";
const MANAGER_B = "7e7a7e70-1111-4000-8000-000000000002";
const PIPELINE_A = "7e7a7e70-5555-4000-8000-000000000001";
const STAGE_A = "7e7a7e70-5555-4000-8000-000000000002";
const CONTACT_A = "7e7a7e70-6666-4000-8000-000000000001";
const LEAD_WITH_CREDS = "7e7a7e70-7777-4000-8000-000000000001";
const LEAD_NO_CREDS_ORG = "7e7a7e70-7777-4000-8000-000000000002";

function eventRow(overrides: Partial<EventRow> & Pick<EventRow, "id" | "organization_id">): EventRow {
  return {
    event_type: "lead.won",
    entity_kind: "lead",
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
}

function failResponse(): Response {
  return new Response("token inválido", { status: 401 });
}

beforeAll(() => {
  sql(`
    do $guc$ begin
      execute format('alter database %I set app.nuvemshop_oauth_key = %L',
                     current_database(), '${GUC_KEY}');
    end $guc$;
    select set_config('app.nuvemshop_oauth_key', '${GUC_KEY}', false);

    insert into auth.users (id, email) values ('${MANAGER_B}', 'm9-meta-capi-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'meta-capi-org-a', 'Meta Capi Org A', 'Meta Capi A'),
      ('${ORG_B}', 'meta-capi-org-b', 'Meta Capi Org B', 'Meta Capi B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE_A}', '${ORG_A}', 'Meta Capi A', 'meta-capi-a')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPELINE_A}', 'Ganho', 'ganho', 1000)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTACT_A}', '${ORG_A}', 'Cliente Meta Capi', '+5531999998888')
      on conflict do nothing;

    -- LEAD_WITH_CREDS: ORG_A, que TEM credencial conectada.
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, contact_id, title, status, value_cents, currency, closed_at,
       source_metadata)
      values ('${LEAD_WITH_CREDS}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', '${CONTACT_A}', 'Venda com credencial',
              'won', 250000, 'BRL', '2026-08-20T12:00:00+00',
              '{"ad_click_id":"AbCdEf123","ad_click_id_type":"ctwa_clid"}'::jsonb)
      on conflict (id) do update set status = excluded.status;

    -- LEAD_NO_CREDS_ORG: ORG_B, que NÃO tem credencial conectada.
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, status, value_cents, currency, closed_at)
      values ('${LEAD_NO_CREDS_ORG}', '${ORG_B}',
              (select id from public.crm_pipelines where organization_id = '${ORG_B}' and is_default limit 1),
              (select id from public.crm_stages where organization_id = '${ORG_B}' and is_won limit 1),
              'Venda sem credencial', 'won', 100000, 'BRL', now())
      on conflict (id) do update set status = excluded.status;

    insert into public.tenant_meta_ads_credentials (organization_id, access_token_encrypted, dataset_id, status)
      values ('${ORG_A}', public.fn_encrypt_oauth('EAAG-token-de-teste'), 'dataset-123', 'healthy')
      on conflict (organization_id) do update set access_token_encrypted = excluded.access_token_encrypted;

    -- Cache de hierarquia (Fase E2) com page_id já resolvido — pro teste do
    -- Purchase que leva user_data.page_id no corpo (migration 0165).
    insert into public.meta_ads_ad_metadata (organization_id, ad_id, page_id)
      values ('${ORG_A}', 'ad-com-page-cacheado', 'page-999')
      on conflict (organization_id, ad_id) do update set page_id = excluded.page_id;
  `);
});

afterAll(async () => {
  await pool.query("delete from public.organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("resolveMetaAdsCredentials", () => {
  it("⭐ sem credencial conectada, devolve null", async () => {
    const creds = await resolveMetaAdsCredentials(db, ORG_B);
    expect(creds).toBeNull();
  });

  it("⭐ com credencial, devolve token decifrado + dataset_id", async () => {
    const creds = await resolveMetaAdsCredentials(db, ORG_A);
    expect(creds).toEqual({ accessToken: "EAAG-token-de-teste", datasetId: "dataset-123" });
  });
});

describe("sendMetaCapiEvent", () => {
  const input = {
    eventName: "Purchase",
    eventId: "evt-send-1",
    eventTimeSeconds: 1_700_000_000,
    valueCents: 250_000,
    currency: "BRL",
    phone: "+5531999998888",
    sourceMetadata: {},
  };

  it("⭐ sem credencial: skipped, NÃO chama fetch nenhum", async () => {
    const fetchImpl = vi.fn();
    const result = await sendMetaCapiEvent(db, ORG_B, input, { fetchImpl });
    expect(result).toEqual({ status: "skipped", error: "no_credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("⭐ com credencial, fetch 200 → sent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const result = await sendMetaCapiEvent(db, ORG_A, input, { fetchImpl });
    expect(result).toEqual({ status: "sent" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain("dataset-123");
    expect(url).toContain("access_token=EAAG-token-de-teste");
  });

  it("⭐ com credencial, fetch 401 → failed com o corpo do erro", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(failResponse());
    const result = await sendMetaCapiEvent(db, ORG_A, input, { fetchImpl });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("http_401");
    expect(result.error).toContain("token inválido");
  });

  it("exceção de rede vira failed, não propaga", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await sendMetaCapiEvent(db, ORG_A, input, { fetchImpl });
    expect(result).toEqual({ status: "failed", error: "network down" });
  });

  // Migration 0165 — a Meta rejeitava (HTTP 400, subcode 2804116) todo
  // Purchase de CTWA por faltar o Page ID do anúncio; achado ao vivo na
  // primeira venda real de um cliente. page_id vem do cache de hierarquia
  // (meta_ads_ad_metadata, Fase E2), não do lead.
  it("⭐ ad_id com page_id cacheado → o corpo do POST leva user_data.page_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const comAdId = {
      ...input,
      sourceMetadata: {
        ad_click_id: "AbCdEf123",
        ad_click_id_type: "ctwa_clid",
        ad_id: "ad-com-page-cacheado",
      },
    };
    const result = await sendMetaCapiEvent(db, ORG_A, comAdId, { fetchImpl });
    expect(result).toEqual({ status: "sent" });
    const [, options] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string) as {
      data: [{ user_data: { page_id?: string } }];
    };
    expect(body.data[0]!.user_data.page_id).toBe("page-999");
  });

  it("ad_id SEM cache (hierarquia ainda não resolvida) → envia mesmo assim, sem page_id no corpo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const semCache = {
      ...input,
      sourceMetadata: { ad_click_id: "XyZ789", ad_click_id_type: "ctwa_clid", ad_id: "ad-nunca-resolvido" },
    };
    const result = await sendMetaCapiEvent(db, ORG_A, semCache, { fetchImpl });
    expect(result).toEqual({ status: "sent" });
    const [, options] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string) as {
      data: [{ user_data: { page_id?: string } }];
    };
    expect(body.data[0]!.user_data.page_id).toBeUndefined();
  });
});

describe("handleLeadWonForMetaCapi", () => {
  it("⭐ lead ganho + credencial conectada + envio OK: grava meta_capi_send_log status='sent'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({
        id: "evt-won-1",
        organization_id: ORG_A,
        entity_id: LEAD_WITH_CREDS,
      });
      const result = await handleLeadWonForMetaCapi(db, row);
      expect(result).toEqual({ consumer_key: "meta-capi-purchase", status: "ok" });

      const out = sql(
        `select status, event_name, meta_error from public.meta_capi_send_log
           where lead_id = '${LEAD_WITH_CREDS}' order by created_at desc limit 1;`,
      );
      const [status, eventName, metaError] = lastLine(out).split("|");
      expect(status).toBe("sent");
      expect(eventName).toBe("Purchase");
      expect(metaError).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("⭐ sem credencial conectada: NÃO grava log nenhum (skip silencioso)", async () => {
    const before = Number(
      lastLine(sql(`select count(*) from public.meta_capi_send_log where organization_id = '${ORG_B}';`)),
    );
    const row = eventRow({ id: "evt-won-2", organization_id: ORG_B, entity_id: LEAD_NO_CREDS_ORG });
    const result = await handleLeadWonForMetaCapi(db, row);
    expect(result).toEqual({ consumer_key: "meta-capi-purchase", status: "ok" });
    const after = Number(
      lastLine(sql(`select count(*) from public.meta_capi_send_log where organization_id = '${ORG_B}';`)),
    );
    expect(after).toBe(before);
  });

  it("lead não encontrado (entity_id inválido): skipped com detail 'no_lead'", async () => {
    const row = eventRow({
      id: "evt-won-3",
      organization_id: ORG_A,
      entity_id: "00000000-0000-4000-8000-000000000000",
    });
    const result = await handleLeadWonForMetaCapi(db, row);
    expect(result).toEqual({ consumer_key: "meta-capi-purchase", status: "skipped", detail: "no_lead" });
  });
});

describe("RLS e anon — mesma doutrina de isolamento multi-tenant", () => {
  function asRole(actorId: string): string {
    return `set role authenticated;
      do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actorId}"}', false); end $c$;`;
  }

  it("⭐ manager de ORG_B não lê a credencial de ORG_A (RLS)", () => {
    const out = sql(`
      ${asRole(MANAGER_B)}
      select count(*) from public.tenant_meta_ads_credentials where organization_id = '${ORG_A}';
    `);
    expect(lastLine(out)).toBe("0");
  });

  it("⭐ anon não tem grant nenhum nas duas tabelas nem na view (tabela nova nasce concedida — precisa revogar)", () => {
    const out = sql(`
      select count(*) from information_schema.role_table_grants
        where grantee = 'anon'
          and table_name in ('tenant_meta_ads_credentials', 'meta_capi_send_log', 'tenant_meta_ads_credentials_safe');
    `);
    expect(lastLine(out)).toBe("0");
  });
});

/**
 * Meta Ads, Fase E1 — schema pra hierarquia de campanha/conjunto/anúncio
 * (migration 0161). Sem função nova, então só prova RLS + anon-revoke +
 * a view segura nunca vazando o token cifrado (só o booleano derivado).
 */
describe("Fase E1 — meta_ads_ad_metadata + ads_read_token_encrypted (migration 0161)", () => {
  const AD_ID_A = "120210000000000";

  function asRole(actorId: string): string {
    return `set role authenticated;
      do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actorId}"}', false); end $c$;`;
  }

  it("⭐ tenant_meta_ads_credentials_safe.ads_read_connected é false sem o segundo token, true depois de gravá-lo", () => {
    const antes = sql(`
      select ads_read_connected from public.tenant_meta_ads_credentials_safe
        where organization_id = '${ORG_A}';
    `);
    expect(lastLine(antes)).toBe("f");

    sql(`
      update public.tenant_meta_ads_credentials
        set ads_read_token_encrypted = public.fn_encrypt_oauth('EAAG-token-leitura-ads')
        where organization_id = '${ORG_A}';
    `);

    const depois = sql(`
      select ads_read_connected from public.tenant_meta_ads_credentials_safe
        where organization_id = '${ORG_A}';
    `);
    expect(lastLine(depois)).toBe("t");
  });

  it("⭐ manager de ORG_B não lê o cache de hierarquia de ORG_A (RLS)", () => {
    sql(`
      insert into public.meta_ads_ad_metadata
        (organization_id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name)
        values ('${ORG_A}', '${AD_ID_A}', 'Anúncio Teste', '999', 'Conjunto Teste', '888', 'Campanha Teste')
        on conflict (organization_id, ad_id) do nothing;
    `);
    const out = sql(`
      ${asRole(MANAGER_B)}
      select count(*) from public.meta_ads_ad_metadata where organization_id = '${ORG_A}';
    `);
    expect(lastLine(out)).toBe("0");
  });

  it("⭐ anon não tem grant nenhum em meta_ads_ad_metadata (tabela nova nasce concedida — precisa revogar)", () => {
    const out = sql(`
      select count(*) from information_schema.role_table_grants
        where grantee = 'anon' and table_name = 'meta_ads_ad_metadata';
    `);
    expect(lastLine(out)).toBe("0");
  });
});
