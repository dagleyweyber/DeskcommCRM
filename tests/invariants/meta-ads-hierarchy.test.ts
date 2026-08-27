import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { resolveMetaAdsReadToken } from "@/lib/meta-ads/credentials";
import { handleLeadCreatedForAdHierarchy } from "@/lib/meta-ads/hierarchy-handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

import { pgComoSupabase } from "../pg-como-supabase";
import { sql, lastLine } from "./gov-helpers";

/**
 * Meta Ads, Fase E2 — resolução de campanha/conjunto de anúncio em segundo
 * plano, reagindo a `lead.created`. Nunca no caminho do webhook (mesma
 * doutrina do handler de Purchase, Fase C1): aqui só se prova que o handler
 * SAI RÁPIDO quando não há o que fazer (sem ad_id, sem token configurado, ou
 * ad_id já cacheado) e que uma falha da Graph API marca o ad_id como
 * "já tentado" em vez de reprocessar pra sempre.
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

const ORG_COM_TOKEN = "a1a1a1a1-0000-4000-8000-000000000001";
const ORG_SEM_TOKEN = "a1a1a1a1-0000-4000-8000-000000000002";
const PIPELINE = "a1a1a1a1-5555-4000-8000-000000000001";
const STAGE = "a1a1a1a1-5555-4000-8000-000000000002";
const PIPELINE_SEM_TOKEN = "a1a1a1a1-5555-4000-8000-000000000003";
const STAGE_SEM_TOKEN = "a1a1a1a1-5555-4000-8000-000000000004";
const LEAD_COM_AD_ID = "a1a1a1a1-7777-4000-8000-000000000001";
const LEAD_SEM_AD_ID = "a1a1a1a1-7777-4000-8000-000000000002";
const LEAD_ORG_SEM_TOKEN = "a1a1a1a1-7777-4000-8000-000000000003";
const LEAD_AD_JA_CACHEADO = "a1a1a1a1-7777-4000-8000-000000000004";
const LEAD_AD_FALHA = "a1a1a1a1-7777-4000-8000-000000000005";

function eventRow(overrides: Partial<EventRow> & Pick<EventRow, "id" | "organization_id" | "entity_id">): EventRow {
  return {
    event_type: "lead.created",
    entity_kind: "lead",
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

beforeAll(() => {
  sql(`
    do $guc$ begin
      execute format('alter database %I set app.nuvemshop_oauth_key = %L',
                     current_database(), '${GUC_KEY}');
    end $guc$;
    select set_config('app.nuvemshop_oauth_key', '${GUC_KEY}', false);

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_COM_TOKEN}', 'meta-ads-hier-com-token', 'Meta Ads Hier Com Token', 'Meta Ads Hier A'),
      ('${ORG_SEM_TOKEN}', 'meta-ads-hier-sem-token', 'Meta Ads Hier Sem Token', 'Meta Ads Hier B')
      on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG_COM_TOKEN}', 'Hier A', 'hier-a'),
      ('${PIPELINE_SEM_TOKEN}', '${ORG_SEM_TOKEN}', 'Hier B', 'hier-b')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE}', '${ORG_COM_TOKEN}', '${PIPELINE}', 'Novo', 'novo', 1000),
      ('${STAGE_SEM_TOKEN}', '${ORG_SEM_TOKEN}', '${PIPELINE_SEM_TOKEN}', 'Novo', 'novo', 1000)
      on conflict do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, source_metadata)
      values ('${LEAD_COM_AD_ID}', '${ORG_COM_TOKEN}', '${PIPELINE}', '${STAGE}', 'Lead com ad_id', 'open', 'meta_ads',
              '{"ad_id":"111"}'::jsonb)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source)
      values ('${LEAD_SEM_AD_ID}', '${ORG_COM_TOKEN}', '${PIPELINE}', '${STAGE}', 'Lead sem ad_id', 'open', 'whatsapp')
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, source_metadata)
      values ('${LEAD_ORG_SEM_TOKEN}', '${ORG_SEM_TOKEN}', '${PIPELINE_SEM_TOKEN}', '${STAGE_SEM_TOKEN}',
              'Lead org sem token', 'open', 'meta_ads', '{"ad_id":"222"}'::jsonb)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, source_metadata)
      values ('${LEAD_AD_JA_CACHEADO}', '${ORG_COM_TOKEN}', '${PIPELINE}', '${STAGE}', 'Lead ad já cacheado', 'open',
              'meta_ads', '{"ad_id":"333"}'::jsonb)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, source_metadata)
      values ('${LEAD_AD_FALHA}', '${ORG_COM_TOKEN}', '${PIPELINE}', '${STAGE}', 'Lead ad token sem permissão', 'open',
              'meta_ads', '{"ad_id":"444"}'::jsonb)
      on conflict (id) do nothing;

    insert into public.meta_ads_ad_metadata (organization_id, ad_id, ad_name, campaign_id, campaign_name)
      values ('${ORG_COM_TOKEN}', '333', 'Anúncio já resolvido', '999', 'Campanha Já Resolvida')
      on conflict (organization_id, ad_id) do nothing;

    insert into public.tenant_meta_ads_credentials
      (organization_id, access_token_encrypted, dataset_id, status, ads_read_token_encrypted)
      values ('${ORG_COM_TOKEN}', public.fn_encrypt_oauth('EAAG-purchase-token'), 'dataset-1', 'healthy',
              public.fn_encrypt_oauth('EAAG-read-token'))
      on conflict (organization_id) do update set ads_read_token_encrypted = excluded.ads_read_token_encrypted;
  `);
});

afterAll(async () => {
  await pool.query("delete from public.organizations where id = any($1)", [[ORG_COM_TOKEN, ORG_SEM_TOKEN]]);
  await pool.end();
});

describe("resolveMetaAdsReadToken", () => {
  it("⭐ sem token de leitura configurado, devolve null", async () => {
    const token = await resolveMetaAdsReadToken(db, ORG_SEM_TOKEN);
    expect(token).toBeNull();
  });

  it("⭐ com token configurado, devolve decifrado", async () => {
    const token = await resolveMetaAdsReadToken(db, ORG_COM_TOKEN);
    expect(token).toBe("EAAG-read-token");
  });
});

describe("handleLeadCreatedForAdHierarchy", () => {
  it("⭐ lead sem ad_id: skipped 'no_ad_id', não chama fetch nem grava cache", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({ id: "evt-1", organization_id: ORG_COM_TOKEN, entity_id: LEAD_SEM_AD_ID });
      const result = await handleLeadCreatedForAdHierarchy(db, row);
      expect(result).toEqual({
        consumer_key: "meta-ads-resolve-hierarchy",
        status: "skipped",
        detail: "no_ad_id",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("⭐ org sem token de leitura: skipped 'no_read_token', não chama fetch", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({ id: "evt-2", organization_id: ORG_SEM_TOKEN, entity_id: LEAD_ORG_SEM_TOKEN });
      const result = await handleLeadCreatedForAdHierarchy(db, row);
      expect(result).toEqual({
        consumer_key: "meta-ads-resolve-hierarchy",
        status: "skipped",
        detail: "no_read_token",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("⭐ ad_id já cacheado: skipped 'already_cached', não refaz a chamada", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({ id: "evt-3", organization_id: ORG_COM_TOKEN, entity_id: LEAD_AD_JA_CACHEADO });
      const result = await handleLeadCreatedForAdHierarchy(db, row);
      expect(result).toEqual({
        consumer_key: "meta-ads-resolve-hierarchy",
        status: "skipped",
        detail: "already_cached",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("⭐ ad_id novo + token configurado: resolve e grava campanha/conjunto no cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "Anúncio Novo",
          adset: { id: "555", name: "Conjunto Novo" },
          campaign: { id: "666", name: "Campanha Nova" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({ id: "evt-4", organization_id: ORG_COM_TOKEN, entity_id: LEAD_COM_AD_ID });
      const result = await handleLeadCreatedForAdHierarchy(db, row);
      expect(result).toEqual({ consumer_key: "meta-ads-resolve-hierarchy", status: "ok" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toContain("access_token=EAAG-read-token");

      const out = sql(`
        select ad_name, adset_name, campaign_name, last_error
          from public.meta_ads_ad_metadata
          where organization_id = '${ORG_COM_TOKEN}' and ad_id = '111';
      `);
      const [adName, adsetName, campaignName, lastError] = lastLine(out).split("|");
      expect(adName).toBe("Anúncio Novo");
      expect(adsetName).toBe("Conjunto Novo");
      expect(campaignName).toBe("Campanha Nova");
      expect(lastError).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("⭐ Graph API falha (token sem permissão): grava o ad_id com last_error, sem reprocessar depois", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Requires ads_read permission" } }), { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const row = eventRow({ id: "evt-5", organization_id: ORG_COM_TOKEN, entity_id: LEAD_AD_FALHA });
      const result = await handleLeadCreatedForAdHierarchy(db, row);
      expect(result).toEqual({ consumer_key: "meta-ads-resolve-hierarchy", status: "ok" });

      const out = sql(`
        select ad_name, last_error from public.meta_ads_ad_metadata
          where organization_id = '${ORG_COM_TOKEN}' and ad_id = '444';
      `);
      const [adName, lastError] = lastLine(out).split("|");
      expect(adName).toBe("");
      expect(lastError).toContain("ads_read permission");

      // Reprocessar o MESMO lead não chama fetch de novo — o ad_id já está
      // marcado como tentado (com erro), o handler sai por "already_cached".
      const row2 = eventRow({ id: "evt-6", organization_id: ORG_COM_TOKEN, entity_id: LEAD_AD_FALHA });
      const result2 = await handleLeadCreatedForAdHierarchy(db, row2);
      expect(result2).toEqual({
        consumer_key: "meta-ads-resolve-hierarchy",
        status: "skipped",
        detail: "already_cached",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
