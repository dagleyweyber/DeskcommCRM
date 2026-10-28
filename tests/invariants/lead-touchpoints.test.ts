import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0202 — `lead_touchpoints`: de onde o lead veio, em campos estruturados.
 *
 * O isolamento entre organizações é provado em `rls-isolation.test.ts` (percurso como
 * usuário autenticado). Aqui: o que o anon pode fazer, e o preenchimento do histórico
 * a partir de `crm_leads.source_metadata` — rodando o SQL REAL da migration, duas
 * vezes, para provar que é idempotente (o `update.sh` do clone reaplica o baseline).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "a0202000-0000-4000-8000-000000000001";
const LEAD_WHATS = "a0202000-0000-4000-8000-0000000000a1";
const LEAD_GOOGLE = "a0202000-0000-4000-8000-0000000000a2";
const LEAD_META_LP = "a0202000-0000-4000-8000-0000000000a3";
const LEAD_ORGANICO = "a0202000-0000-4000-8000-0000000000a4";

/** O bloco de backfill exatamente como está na migration. */
function backfillDaMigration(): string {
  const arquivo = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261027180000_0202_lead_touchpoints.sql"),
    "utf8",
  );
  const inicio = arquivo.indexOf("insert into public.lead_touchpoints (");
  const fim = arquivo.indexOf("notify pgrst", inicio);
  if (inicio < 0 || fim < 0) throw new Error("bloco de backfill não encontrado na migration");
  return arquivo.slice(inicio, fim);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-touchpoints', 'Touchpoints LTDA', 'Touchpoints')
      on conflict (id) do nothing;
    do $seed$
    declare v_pipe uuid; v_stage uuid;
    begin
      select id into v_pipe from public.crm_pipelines where organization_id = '${ORG}' and is_default limit 1;
      if v_pipe is null then
        insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG}', 'T', 't') returning id into v_pipe;
      end if;
      select id into v_stage from public.crm_stages where organization_id = '${ORG}' and pipeline_id = v_pipe order by position limit 1;
      if v_stage is null then
        insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
          values ('${ORG}', v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
      end if;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, source, source_metadata) values
        ('${LEAD_WHATS}', '${ORG}', v_pipe, v_stage, 'Whats', 'meta_ads',
          '{"ad_click_id":"ARAk_1","ad_click_id_type":"ctwa_clid","ad_id":"120244","ad_headline":"Avaliação grátis","ad_source_url":"https://fb.me/x"}'),
        ('${LEAD_GOOGLE}', '${ORG}', v_pipe, v_stage, 'Google', 'webhook',
          '{"gclid":"Cj0K_1","utm_source":"google","campaign_id":"987654321","adgroup_id":"112233","creative":"667788","keyword":"laser"}'),
        ('${LEAD_META_LP}', '${ORG}', v_pipe, v_stage, 'Meta LP', 'webhook',
          '{"utm_source":"facebook","fbclid":"IwAR_1","campaign_id":"120211","adset_id":"120222","ad_id":"120233"}'),
        ('${LEAD_ORGANICO}', '${ORG}', v_pipe, v_stage, 'Orgânico', 'whatsapp', '{}')
      on conflict (id) do nothing;
    end
    $seed$;
  `);
});

describe("lead_touchpoints — permissões", () => {
  it("⭐ RLS ligada e anon sem nenhum privilégio (tabela nova nasce concedida a anon)", () => {
    const out = sql(`
      select c.relrowsecurity,
             has_table_privilege('anon', 'public.lead_touchpoints', 'select'),
             has_table_privilege('anon', 'public.lead_touchpoints', 'insert')
        from pg_class c where c.oid = 'public.lead_touchpoints'::regclass;
    `);
    expect(out).toBe("t|f|f");
  });

  it("usuário autenticado não tem policy de escrita — atribuição só é gravada pelo servidor", () => {
    const out = sql(`
      select string_agg(cmd, ',' order by cmd) from pg_policies
       where schemaname = 'public' and tablename = 'lead_touchpoints';
    `);
    expect(out).toBe("SELECT");
  });
});

describe("lead_touchpoints — preenchimento do histórico (SQL da migration)", () => {
  it("⭐ cada lead com origem vira um ponto de contato com canal, clique e ids certos; reaplicar não duplica", () => {
    sql(`delete from public.lead_touchpoints where organization_id = '${ORG}';`);
    const backfill = backfillDaMigration();
    sql(backfill);
    sql(backfill); // update.sh reaplica o baseline

    const linhas = sql(`
      select lead_id, canal, via, coalesce(click_id_type,'-'), coalesce(campaign_id,'-'),
             coalesce(adset_id,'-'), coalesce(ad_id,'-'), coalesce(keyword,'-')
        from public.lead_touchpoints where organization_id = '${ORG}' order by lead_id;
    `).split("\n");

    expect(linhas).toEqual([
      `${LEAD_WHATS}|meta_ads|anuncio_whatsapp|ctwa_clid|-|-|120244|-`,
      `${LEAD_GOOGLE}|google_ads|historico|gclid|987654321|112233|667788|laser`,
      `${LEAD_META_LP}|meta_ads|historico|fbclid|120211|120222|120233|-`,
    ]);
  });

  it("o título do anúncio de WhatsApp vai para extras, e a data é a de criação do lead", () => {
    const out = sql(`
      select t.extras->>'ad_headline', t.occurred_at = l.created_at
        from public.lead_touchpoints t join public.crm_leads l on l.id = t.lead_id
       where t.lead_id = '${LEAD_WHATS}';
    `);
    expect(out).toBe("Avaliação grátis|t");
  });

  it("lead orgânico (sem nenhuma origem) não ganha ponto de contato inventado", () => {
    expect(sql(`select count(*) from public.lead_touchpoints where lead_id = '${LEAD_ORGANICO}';`)).toBe("0");
  });

  it("apagar o lead apaga os pontos de contato dele (cascade)", () => {
    expect(sql(`select count(*) from public.lead_touchpoints where lead_id = '${LEAD_META_LP}';`)).toBe("1");
    sql(`delete from public.crm_leads where id = '${LEAD_META_LP}';`);
    expect(sql(`select count(*) from public.lead_touchpoints where lead_id = '${LEAD_META_LP}';`)).toBe("0");
  });
});
