import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Dashboard de Vendas, Fase 1 (migration 0155) — `fn_sales_dashboard`. Dataset
 * SEED CONHECIDO, números EXATOS (não "> 0"), + prova de isolamento entre 2
 * orgs (doutrina de multi-tenancy do CLAUDE.md: obrigatório antes de merge).
 *
 * Namespace 05050505… (exclusivo deste arquivo). Sem PII: e-mails
 * @invariant.test. Timestamps LITERAIS fixos (não now()) para agregações
 * determinísticas. Datas escolhidas de propósito para não cair em ponto médio
 * de arredondamento (ex.: tempo_conversao_medio_dias = 19.0 exato, não 18.75).
 */

const ORG_A = "05050505-0000-4000-8000-000000000001";
const ORG_B = "05050505-0000-4000-8000-000000000002";
const ORG_C = "05050505-0000-4000-8000-000000000003";
const MANAGER_A = "05050505-1111-4000-8000-000000000001";
const MANAGER_B = "05050505-1111-4000-8000-000000000002";
const MANAGER_C = "05050505-1111-4000-8000-000000000003";
const PIPELINE_A = "05050505-5555-4000-8000-000000000001";
const STAGE_A = "05050505-5555-4000-8000-000000000002";
const PIPELINE_B = "05050505-5555-4000-8000-000000000003";
const STAGE_B = "05050505-5555-4000-8000-000000000004";
// ORG_C é exclusivo dos testes de filtro (pipeline/origem) — dataset separado
// de ORG_A pra não recalcular os números exatos já verificados acima.
const PIPELINE_C1 = "05050505-5555-4000-8000-000000000005";
const STAGE_C1 = "05050505-5555-4000-8000-000000000006";
const PIPELINE_C2 = "05050505-5555-4000-8000-000000000007";
const STAGE_C2 = "05050505-5555-4000-8000-000000000008";
// ORG_D é exclusivo dos testes de Fase 2 (receita por serviço + objeções) —
// dataset separado, mesma razão do ORG_C acima.
const ORG_D = "05050505-0000-4000-8000-000000000004";
const MANAGER_D = "05050505-1111-4000-8000-000000000004";
const PIPELINE_D = "05050505-5555-4000-8000-000000000009";
const STAGE_D = "05050505-5555-4000-8000-00000000000a";
const LEAD_D1 = "05050505-6666-4000-8000-000000000001"; // Botox
const LEAD_D2 = "05050505-6666-4000-8000-000000000002"; // Botox
const LEAD_D3 = "05050505-6666-4000-8000-000000000003"; // Preenchimento
const LEAD_D4 = "05050505-6666-4000-8000-000000000004"; // sem produto_interesse

const FROM = "2026-07-01T00:00:00+00";
const TO = "2026-07-31T00:00:00+00";
const D1 = "2026-07-10T12:00:00+00"; // 3 opens + 2 won (whatsapp) + 1 won-old fecha aqui
const D2 = "2026-07-15T12:00:00+00"; // 1 won (instagram) criado aqui + 1 lost (instagram)
const D3 = "2026-07-21T12:00:00+00"; // o won criado em D2 fecha aqui (6 dias depois)
const OLD = "2026-05-01T12:00:00+00"; // criado ANTES da janela — não conta em leads_total

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'm9-manager-a@invariant.test'),
      ('${MANAGER_B}', 'm9-manager-b@invariant.test'),
      ('${MANAGER_C}', 'm9-manager-c@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'gov-sales-a', 'Gov Sales Org A', 'Gov Sales A'),
      ('${ORG_B}', 'gov-sales-b', 'Gov Sales Org B', 'Gov Sales B'),
      ('${ORG_C}', 'gov-sales-c', 'Gov Sales Org C', 'Gov Sales C')
    on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now()),
      ('${MANAGER_C}', '${ORG_C}', 'manager', now())
    on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE_A}', '${ORG_A}', 'Gov Sales A', 'gov-sales-a'),
      ('${PIPELINE_B}', '${ORG_B}', 'Gov Sales B', 'gov-sales-b'),
      ('${PIPELINE_C1}', '${ORG_C}', 'Gov Sales C1', 'gov-sales-c1'),
      ('${PIPELINE_C2}', '${ORG_C}', 'Gov Sales C2', 'gov-sales-c2')
    on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPELINE_A}', 'Novo', 'novo', 1000),
      ('${STAGE_B}', '${ORG_B}', '${PIPELINE_B}', 'Novo', 'novo', 1000),
      ('${STAGE_C1}', '${ORG_C}', '${PIPELINE_C1}', 'Novo', 'novo', 1000),
      ('${STAGE_C2}', '${ORG_C}', '${PIPELINE_C2}', 'Novo', 'novo', 1000)
    on conflict do nothing;

    -- ORG_A: 3 opens (whatsapp, D1) + 2 won (whatsapp, D1→D1, 100000 cada) +
    -- 1 won (instagram, D2→D3, 50000) + 1 lost (instagram, D2) + 1 won criado
    -- FORA da janela mas fechado DENTRO (whatsapp, OLD→D1, 999900) — conta em
    -- vendas/receita, NÃO em leads_total (sem coorte, documentado na migration).
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, created_at)
      select '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'A open '||g, 'open', 'whatsapp', '${D1}'
      from generate_series(1,3) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      select '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'A won wa '||g, 'won', 'whatsapp', 100000, '${D1}', '${D1}'
      from generate_series(1,2) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'A won ig', 'won', 'instagram', 50000, '${D2}', '${D3}');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, lost_reason, created_at, closed_at)
      values ('${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'A lost ig', 'lost', 'instagram', 'price', '${D2}', '${D2}');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'A won old', 'won', 'whatsapp', 999900, '${OLD}', '${D1}');

    -- ORG_B: 1 won gigante, pra provar que NÃO vaza pra ORG_A.
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${ORG_B}', '${PIPELINE_B}', '${STAGE_B}', 'B won grande', 'won', 'meta_ads', 99999900, '${D1}', '${D1}');

    -- ORG_C: dataset exclusivo dos testes de filtro p_pipeline_id/p_source —
    -- um won em cada pipeline/origem, pra não recalcular os números de ORG_A.
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${ORG_C}', '${PIPELINE_C1}', '${STAGE_C1}', 'C won wa', 'won', 'whatsapp', 100000, '${D1}', '${D1}');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${ORG_C}', '${PIPELINE_C2}', '${STAGE_C2}', 'C won ig', 'won', 'instagram', 200000, '${D1}', '${D1}');

    -- ORG_D: dataset exclusivo dos testes de Fase 2 (receita por serviço +
    -- objeções). 4 leads won — 2 Botox, 1 Preenchimento, 1 SEM produto_interesse
    -- (vira "Não informado" no relatório, mas ainda soma na receita).
    insert into auth.users (id, email) values ('${MANAGER_D}', 'm9-manager-d@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_D}', 'gov-sales-d', 'Gov Sales Org D', 'Gov Sales D')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_D}', '${ORG_D}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_D}', '${ORG_D}', 'Gov Sales D', 'gov-sales-d')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_D}', '${ORG_D}', '${PIPELINE_D}', 'Novo', 'novo', 1000)
      on conflict do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, custom_fields, created_at, closed_at)
      values ('${LEAD_D1}', '${ORG_D}', '${PIPELINE_D}', '${STAGE_D}', 'D won botox 1', 'won', 'whatsapp', 100000, '{"produto_interesse":"Botox"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, custom_fields, created_at, closed_at)
      values ('${LEAD_D2}', '${ORG_D}', '${PIPELINE_D}', '${STAGE_D}', 'D won botox 2', 'won', 'whatsapp', 50000, '{"produto_interesse":"Botox"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, custom_fields, created_at, closed_at)
      values ('${LEAD_D3}', '${ORG_D}', '${PIPELINE_D}', '${STAGE_D}', 'D won preenchimento', 'won', 'whatsapp', 200000, '{"produto_interesse":"Preenchimento"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${LEAD_D4}', '${ORG_D}', '${PIPELINE_D}', '${STAGE_D}', 'D won sem servico', 'won', 'whatsapp', 30000, '${D1}', '${D1}');

    -- Objeções: 2x "price" no LEAD_D1 (repete no MESMO lead — quantidade conta
    -- OCORRÊNCIAS, não leads distintos), 1x "need_to_think" no LEAD_D2, 1 FORA
    -- da janela (não deve contar) e 1 de outro TYPE (não deve contar).
    insert into public.crm_lead_activities (organization_id, lead_id, source_module, type, actor_kind, performed_by_user_id, reason, payload, performed_at)
      values
        ('${ORG_D}', '${LEAD_D1}', 'gov-invariant-test', 'objection', 'user', '${MANAGER_D}', 'Preço', '{"code":"price"}'::jsonb, '${D1}'),
        ('${ORG_D}', '${LEAD_D1}', 'gov-invariant-test', 'objection', 'user', '${MANAGER_D}', 'Preço', '{"code":"price"}'::jsonb, '${D1}'),
        ('${ORG_D}', '${LEAD_D2}', 'gov-invariant-test', 'objection', 'user', '${MANAGER_D}', 'Precisa pensar', '{"code":"need_to_think"}'::jsonb, '${D1}'),
        ('${ORG_D}', '${LEAD_D1}', 'gov-invariant-test', 'objection', 'user', '${MANAGER_D}', 'Preço', '{"code":"price"}'::jsonb, '${OLD}'),
        ('${ORG_D}', '${LEAD_D1}', 'gov-invariant-test', 'note', 'user', '${MANAGER_D}', 'Anotação qualquer', '{}'::jsonb, '${D1}');
  `);
});

function asRole(actorId: string): string {
  return `set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actorId}"}', false); end $c$;`;
}

interface Kpis {
  leads_total: number;
  vendas: number;
  receita_total_cents: number;
  valor_medio_cents: number | null;
  conversao_pct: number | null;
  tempo_conversao_medio_dias: number | null;
}
interface DiaRow {
  dia: string;
  criados: number;
  convertidos: number;
}
interface OrigemRow {
  origem: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}
interface ServicoRow {
  servico: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}
interface ObjecaoRow {
  motivo: string;
  quantidade: number;
}
interface Dashboard {
  kpis: Kpis;
  leads_por_dia: DiaRow[];
  receita_por_origem: OrigemRow[];
  receita_por_servico: ServicoRow[];
  principais_objecoes: ObjecaoRow[];
}

function fetchDashboard(
  actorId: string,
  org: string,
  filtro?: { pipelineId?: string; source?: string },
): Dashboard {
  const pArg = filtro?.pipelineId ? `'${filtro.pipelineId}'::uuid` : "null";
  const sArg = filtro?.source ? `'${filtro.source}'` : "null";
  const out = sql(`
    ${asRole(actorId)}
    select public.fn_sales_dashboard('${org}', '${FROM}', '${TO}', ${pArg}, ${sArg})::text;
  `);
  return JSON.parse(lastLine(out)) as Dashboard;
}

describe("Dashboard de Vendas, Fase 1 — fn_sales_dashboard (números exatos)", () => {
  const dashboard = () => fetchDashboard(MANAGER_A, ORG_A);

  it("kpis: leads_total=7 (o won criado FORA da janela não entra)", () => {
    expect(dashboard().kpis.leads_total).toBe(7);
  });

  it("kpis: vendas=4, receita_total_cents=1249900, valor_medio_cents=312475", () => {
    const k = dashboard().kpis;
    expect(k.vendas).toBe(4);
    expect(k.receita_total_cents).toBe(1_249_900);
    expect(k.valor_medio_cents).toBe(312_475);
  });

  it("kpis: conversao_pct=57.1 (4/7*100, arredondado a 1 casa)", () => {
    expect(dashboard().kpis.conversao_pct).toBe(57.1);
  });

  it("kpis: tempo_conversao_medio_dias=19 (média de 0,0,6,70 dias)", () => {
    expect(dashboard().kpis.tempo_conversao_medio_dias).toBe(19);
  });

  it("leads_por_dia: D1 criados=5 (3 opens+2 won), convertidos=3 (2 won+1 won-old)", () => {
    const dia = dashboard().leads_por_dia.find((d) => d.dia === "2026-07-10");
    expect(dia).toEqual({ dia: "2026-07-10", criados: 5, convertidos: 3 });
  });

  it("leads_por_dia: D2 criados=2 (1 won ig+1 lost ig), convertidos=0", () => {
    const dia = dashboard().leads_por_dia.find((d) => d.dia === "2026-07-15");
    expect(dia).toEqual({ dia: "2026-07-15", criados: 2, convertidos: 0 });
  });

  it("leads_por_dia: D3 criados=0, convertidos=1 (o won ig fecha aqui)", () => {
    const dia = dashboard().leads_por_dia.find((d) => d.dia === "2026-07-21");
    expect(dia).toEqual({ dia: "2026-07-21", criados: 0, convertidos: 1 });
  });

  it("leads_por_dia: dia sem nenhum evento aparece com zeros (série completa, não esparsa)", () => {
    const dia = dashboard().leads_por_dia.find((d) => d.dia === "2026-07-01");
    expect(dia).toEqual({ dia: "2026-07-01", criados: 0, convertidos: 0 });
  });

  it("receita_por_origem: whatsapp leads=5, vendas=3, receita_cents=1199900", () => {
    const wa = dashboard().receita_por_origem.find((o) => o.origem === "whatsapp");
    expect(wa).toEqual({ origem: "whatsapp", leads: 5, vendas: 3, receita_cents: 1_199_900 });
  });

  it("receita_por_origem: instagram leads=2, vendas=1, receita_cents=50000", () => {
    const ig = dashboard().receita_por_origem.find((o) => o.origem === "instagram");
    expect(ig).toEqual({ origem: "instagram", leads: 2, vendas: 1, receita_cents: 50_000 });
  });

  // ---- isolamento entre orgs (obrigatório: CLAUDE.md doutrina de multi-tenancy) ----

  it("⭐ ORG_A NÃO vê o lead gigante de ORG_B (receita_total_cents não muda)", () => {
    expect(dashboard().kpis.receita_total_cents).toBe(1_249_900);
    expect(dashboard().receita_por_origem.find((o) => o.origem === "meta_ads")).toBeUndefined();
  });

  it("⭐ ORG_B vê só o próprio lead (manager de A não vaza pra B nem vice-versa)", () => {
    const b = fetchDashboard(MANAGER_B, ORG_B);
    expect(b.kpis).toEqual({
      leads_total: 1,
      vendas: 1,
      receita_total_cents: 99_999_900,
      valor_medio_cents: 99_999_900,
      conversao_pct: 100,
      tempo_conversao_medio_dias: 0,
    });
  });

  it("⭐ manager de ORG_B não consegue ler o dashboard de ORG_A (RLS: kpis zerados)", () => {
    const crossOrg = fetchDashboard(MANAGER_B, ORG_A);
    expect(crossOrg.kpis.leads_total).toBe(0);
    expect(crossOrg.kpis.vendas).toBe(0);
    expect(crossOrg.kpis.receita_total_cents).toBe(0);
  });
});

// ---- migration 0156: filtro por pipeline e por origem ----

describe("fn_sales_dashboard — filtro p_pipeline_id/p_source (migration 0156)", () => {
  it("sem filtro: ORG_C soma os dois pipelines/origens (leads_total=2, receita=300000)", () => {
    const d = fetchDashboard(MANAGER_C, ORG_C);
    expect(d.kpis).toMatchObject({ leads_total: 2, vendas: 2, receita_total_cents: 300_000 });
  });

  it("⭐ p_pipeline_id restringe ao pipeline escolhido — o won do OUTRO pipeline some", () => {
    const d = fetchDashboard(MANAGER_C, ORG_C, { pipelineId: PIPELINE_C1 });
    expect(d.kpis).toMatchObject({ leads_total: 1, vendas: 1, receita_total_cents: 100_000 });
    expect(d.receita_por_origem).toEqual([
      { origem: "whatsapp", leads: 1, vendas: 1, receita_cents: 100_000 },
    ]);
  });

  it("⭐ p_source restringe à origem escolhida — receita_por_origem colapsa para 1 linha, sem caso especial", () => {
    const d = fetchDashboard(MANAGER_C, ORG_C, { source: "instagram" });
    expect(d.kpis).toMatchObject({ leads_total: 1, vendas: 1, receita_total_cents: 200_000 });
    expect(d.receita_por_origem).toEqual([
      { origem: "instagram", leads: 1, vendas: 1, receita_cents: 200_000 },
    ]);
  });

  it("pipeline + origem que não combinam ⇒ zero (o won ig não está no pipeline C1)", () => {
    const d = fetchDashboard(MANAGER_C, ORG_C, { pipelineId: PIPELINE_C1, source: "instagram" });
    expect(d.kpis).toMatchObject({ leads_total: 0, vendas: 0, receita_total_cents: 0 });
  });
});

// ---- migration 0157: receita por serviço + principais objeções ----

describe("fn_sales_dashboard — Fase 2 (receita por serviço + objeções, migration 0157)", () => {
  const dashboard = () => fetchDashboard(MANAGER_D, ORG_D);

  it("⭐ receita_por_servico: Preenchimento(200000) > Botox(150000, 2 leads somados) > Não informado(30000)", () => {
    expect(dashboard().receita_por_servico).toEqual([
      { servico: "Preenchimento", leads: 1, vendas: 1, receita_cents: 200_000 },
      { servico: "Botox", leads: 2, vendas: 2, receita_cents: 150_000 },
      { servico: "Não informado", leads: 1, vendas: 1, receita_cents: 30_000 },
    ]);
  });

  it("⭐ principais_objecoes: price=2 (duas no MESMO lead — conta ocorrência, não lead distinto), need_to_think=1", () => {
    expect(dashboard().principais_objecoes).toEqual([
      { motivo: "price", quantidade: 2 },
      { motivo: "need_to_think", quantidade: 1 },
    ]);
  });

  it("objeção FORA da janela e de outro type ('note') não entram na contagem", () => {
    // Se contassem, price seria 3 (não 2) — o teste acima já provaria isso
    // errado sozinho; este é o controle explícito do PORQUÊ.
    const total = dashboard().principais_objecoes.reduce((acc, o) => acc + o.quantidade, 0);
    expect(total).toBe(3);
  });
});
