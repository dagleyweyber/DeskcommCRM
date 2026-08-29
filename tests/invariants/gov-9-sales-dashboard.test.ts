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
// ORG_E é exclusivo dos testes de Fase 3 (funil de agendamento) — dataset
// separado, mesma razão do ORG_D acima.
const ORG_E = "05050505-0000-4000-8000-000000000005";
const MANAGER_E = "05050505-1111-4000-8000-000000000005";
const PIPELINE_E = "05050505-5555-4000-8000-00000000000b";
const STAGE_E = "05050505-5555-4000-8000-00000000000c";
const LEAD_E1 = "05050505-7777-4000-8000-000000000001"; // agendou, compareceu, fechou
const LEAD_E2 = "05050505-7777-4000-8000-000000000002"; // agendou, compareceu, NÃO fechou
const LEAD_E3 = "05050505-7777-4000-8000-000000000003"; // agendou, NÃO compareceu
const LEAD_E4 = "05050505-7777-4000-8000-000000000004"; // agendou, ainda sem desfecho
// ORG_F é exclusivo dos testes de Fase 4/D (receita por anúncio) — dataset
// separado, mesma razão do ORG_D acima.
const ORG_F = "05050505-0000-4000-8000-000000000006";
const MANAGER_F = "05050505-1111-4000-8000-000000000006";
const PIPELINE_F = "05050505-5555-4000-8000-00000000000d";
const STAGE_F = "05050505-5555-4000-8000-00000000000e";
const LEAD_F1 = "05050505-8888-4000-8000-000000000001"; // ad-1, com headline
const LEAD_F2 = "05050505-8888-4000-8000-000000000002"; // ad-1, sem headline nesta linha
const LEAD_F3 = "05050505-8888-4000-8000-000000000003"; // ad-2
const LEAD_F4 = "05050505-8888-4000-8000-000000000004"; // sem ad_id (orgânico)
// ORG_G é exclusivo dos testes de Fase 5 ("cliente já existente": leads_total
// exclui existing_customer + LTV/recompra), dataset separado, mesma razão do
// ORG_D acima.
const ORG_G = "05050505-0000-4000-8000-000000000007";
const MANAGER_G = "05050505-1111-4000-8000-000000000007";
const PIPELINE_G = "05050505-5555-4000-8000-00000000000f";
const STAGE_G = "05050505-5555-4000-8000-000000000010";
const CONTACT_G1 = "05050505-9999-4000-8000-000000000001"; // recompra: 2 wins
const CONTACT_G2 = "05050505-9999-4000-8000-000000000002"; // 1 win só
const LEAD_G1 = "05050505-8888-4000-8000-000000000005"; // G1, won, DENTRO da janela
const LEAD_G2 = "05050505-8888-4000-8000-000000000006"; // G1, won, FORA da janela (prova LTV é lifetime)
const LEAD_G3 = "05050505-8888-4000-8000-000000000007"; // G2, won, dentro da janela
const LEAD_G4 = "05050505-8888-4000-8000-000000000008"; // existing_customer, dentro da janela

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

    -- ORG_E: dataset exclusivo dos testes de Fase 3 (funil de agendamento).
    -- E1 agendou+compareceu+fechou, E2 agendou+compareceu mas segue aberto,
    -- E3 agendou e NÃO compareceu, E4 agendou e ainda não tem desfecho.
    insert into auth.users (id, email) values ('${MANAGER_E}', 'm9-manager-e@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_E}', 'gov-sales-e', 'Gov Sales Org E', 'Gov Sales E')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_E}', '${ORG_E}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_E}', '${ORG_E}', 'Gov Sales E', 'gov-sales-e')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_E}', '${ORG_E}', '${PIPELINE_E}', 'Novo', 'novo', 1000)
      on conflict do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${LEAD_E1}', '${ORG_E}', '${PIPELINE_E}', '${STAGE_E}', 'E won', 'won', 'whatsapp', 100000, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, created_at)
      values ('${LEAD_E2}', '${ORG_E}', '${PIPELINE_E}', '${STAGE_E}', 'E open compareceu', 'open', 'whatsapp', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, created_at)
      values ('${LEAD_E3}', '${ORG_E}', '${PIPELINE_E}', '${STAGE_E}', 'E open no-show', 'open', 'whatsapp', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, created_at)
      values ('${LEAD_E4}', '${ORG_E}', '${PIPELINE_E}', '${STAGE_E}', 'E open sem desfecho', 'open', 'whatsapp', '${D1}');

    insert into public.crm_lead_activities (organization_id, lead_id, source_module, type, actor_kind, performed_by_user_id, reason, payload, performed_at)
      values
        ('${ORG_E}', '${LEAD_E1}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_E}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E1}', 'gov-invariant-test', 'meeting_outcome', 'user', '${MANAGER_E}', 'Compareceu', '{"outcome":"attended","scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E2}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_E}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E2}', 'gov-invariant-test', 'meeting_outcome', 'user', '${MANAGER_E}', 'Compareceu', '{"outcome":"attended","scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E3}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_E}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E3}', 'gov-invariant-test', 'meeting_outcome', 'user', '${MANAGER_E}', 'Não compareceu', '{"outcome":"no_show","scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E4}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_E}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_E}', '${LEAD_E4}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_E}', 'Agendado FORA da janela', '{"scheduled_at":"${OLD}"}'::jsonb, '${OLD}'),
        ('${ORG_E}', '${LEAD_E4}', 'gov-invariant-test', 'note', 'user', '${MANAGER_E}', 'Anotação qualquer', '{}'::jsonb, '${D1}');

    -- ORG_F: dataset exclusivo dos testes de Fase D (receita por anúncio).
    -- F1+F2 no MESMO anúncio (ad-1, só F1 carrega o headline — prova que o
    -- agrupamento é pelo ad_id e o headline vem de qualquer uma das linhas),
    -- F3 em outro anúncio (ad-2), F4 SEM atribuição nenhuma (orgânico).
    insert into auth.users (id, email) values ('${MANAGER_F}', 'm9-manager-f@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_F}', 'gov-sales-f', 'Gov Sales Org F', 'Gov Sales F')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_F}', '${ORG_F}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_F}', '${ORG_F}', 'Gov Sales F', 'gov-sales-f')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_F}', '${ORG_F}', '${PIPELINE_F}', 'Novo', 'novo', 1000)
      on conflict do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, source_metadata, created_at, closed_at)
      values ('${LEAD_F1}', '${ORG_F}', '${PIPELINE_F}', '${STAGE_F}', 'F won ad-1 com headline', 'won', 'whatsapp', 100000,
              '{"ad_id":"ad-1","ad_headline":"Promoção de Verão"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, source_metadata, created_at, closed_at)
      values ('${LEAD_F2}', '${ORG_F}', '${PIPELINE_F}', '${STAGE_F}', 'F won ad-1 sem headline', 'won', 'whatsapp', 50000,
              '{"ad_id":"ad-1"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, source_metadata, created_at, closed_at)
      values ('${LEAD_F3}', '${ORG_F}', '${PIPELINE_F}', '${STAGE_F}', 'F won ad-2', 'won', 'whatsapp', 200000,
              '{"ad_id":"ad-2","ad_headline":"Campanha Inverno"}'::jsonb, '${D1}', '${D1}');
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, source, value_cents, created_at, closed_at)
      values ('${LEAD_F4}', '${ORG_F}', '${PIPELINE_F}', '${STAGE_F}', 'F won organico sem anuncio', 'won', 'whatsapp', 999999, '${D1}', '${D1}');

    -- Fase E3: hierarquia cacheada (Fase E1/E2) pros dois anúncios de ORG_F.
    insert into public.meta_ads_ad_metadata (organization_id, ad_id, campaign_id, campaign_name, adset_id, adset_name)
      values
        ('${ORG_F}', 'ad-1', 'cg-verao', 'CG Verão', 'adset-a', 'Conjunto A'),
        ('${ORG_F}', 'ad-2', 'cg-inverno', 'CG Inverno', 'adset-b', 'Conjunto B')
      on conflict (organization_id, ad_id) do nothing;

    -- LEAD_F1 tem DOIS meeting_scheduled (remarcação) — prova que o EXISTS
    -- correlacionado conta o LEAD uma vez só, não duplica leads/vendas nem
    -- agendamentos do ad-1. LEAD_F3 (ad-2) tem um só.
    insert into public.crm_lead_activities (organization_id, lead_id, source_module, type, actor_kind, performed_by_user_id, reason, payload, performed_at)
      values
        ('${ORG_F}', '${LEAD_F1}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_F}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_F}', '${LEAD_F1}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_F}', 'Remarcado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}'),
        ('${ORG_F}', '${LEAD_F3}', 'gov-invariant-test', 'meeting_scheduled', 'user', '${MANAGER_F}', 'Agendado', '{"scheduled_at":"${D1}"}'::jsonb, '${D1}');

    -- ORG_G: dataset exclusivo dos testes de Fase 5 ("cliente já existente").
    -- CONTACT_G1 compra 2x (uma DENTRO da janela, outra FORA — prova que
    -- LTV/recompra são LIFETIME, não presos a from/to); CONTACT_G2 compra 1x.
    -- LEAD_G4 é existing_customer, criado DENTRO da janela — prova que
    -- leads_total não conta (seria 3, não 2, se contasse).
    insert into auth.users (id, email) values ('${MANAGER_G}', 'm9-manager-g@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_G}', 'gov-sales-g', 'Gov Sales Org G', 'Gov Sales G')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_G}', '${ORG_G}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_G}', '${ORG_G}', 'Gov Sales G', 'gov-sales-g')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_G}', '${ORG_G}', '${PIPELINE_G}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values
        ('${CONTACT_G1}', '${ORG_G}', 'Cliente Recompra', '+5531900000101'),
        ('${CONTACT_G2}', '${ORG_G}', 'Cliente Única Compra', '+5531900000102')
      on conflict (id) do nothing;

    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, contact_id, title, status, source, value_cents, created_at, closed_at)
      values
        ('${LEAD_G1}', '${ORG_G}', '${PIPELINE_G}', '${STAGE_G}', '${CONTACT_G1}', 'G1 1ª compra (na janela)',
         'won', 'whatsapp', 100000, '${D1}', '${D1}'),
        ('${LEAD_G2}', '${ORG_G}', '${PIPELINE_G}', '${STAGE_G}', '${CONTACT_G1}', 'G1 2ª compra (FORA da janela)',
         'won', 'whatsapp', 50000, '${OLD}', '${OLD}'),
        ('${LEAD_G3}', '${ORG_G}', '${PIPELINE_G}', '${STAGE_G}', '${CONTACT_G2}', 'G2 compra única',
         'won', 'whatsapp', 200000, '${D1}', '${D1}'),
        ('${LEAD_G4}', '${ORG_G}', '${PIPELINE_G}', '${STAGE_G}', '${CONTACT_G1}', 'G1 reconhecido cliente já existente',
         'existing_customer', 'whatsapp', null, '${D1}', '${D1}');
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
  ltv_medio_cents: number | null;
  taxa_recompra_pct: number | null;
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
interface FunilAgendamento {
  agendados: number;
  compareceram: number;
  nao_compareceram: number;
  compareceram_e_fecharam: number;
  taxa_comparecimento_pct: number | null;
}
interface AnuncioRow {
  anuncio: string;
  ad_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  leads: number;
  vendas: number;
  agendamentos: number;
  receita_cents: number;
}
interface Dashboard {
  kpis: Kpis;
  leads_por_dia: DiaRow[];
  receita_por_origem: OrigemRow[];
  receita_por_servico: ServicoRow[];
  principais_objecoes: ObjecaoRow[];
  funil_agendamento: FunilAgendamento;
  receita_por_anuncio: AnuncioRow[];
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
      // O lead de ORG_B não tem contact_id (linha 122) — `clientes` (Fase 5)
      // só conta quem tem contato, então fica vazio: null, não zero.
      ltv_medio_cents: null,
      taxa_recompra_pct: null,
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

// ---- migration 0158: funil real (agendamento → presença → conversão) ----

describe("fn_sales_dashboard — Fase 3 (funil de agendamento, migration 0158)", () => {
  const dashboard = () => fetchDashboard(MANAGER_E, ORG_E);

  it("⭐ agendados=4 (E1..E4 — o agendamento FORA da janela de E4 conta só o lead, não dobra)", () => {
    expect(dashboard().funil_agendamento.agendados).toBe(4);
  });

  it("⭐ compareceram=2 (E1+E2), nao_compareceram=1 (E3) — E4 sem desfecho não entra em nenhum dos dois", () => {
    const f = dashboard().funil_agendamento;
    expect(f.compareceram).toBe(2);
    expect(f.nao_compareceram).toBe(1);
  });

  it("⭐ compareceram_e_fecharam=1 — só E1 (won); E2 compareceu mas segue 'open'", () => {
    expect(dashboard().funil_agendamento.compareceram_e_fecharam).toBe(1);
  });

  it("taxa_comparecimento_pct=66.7 (2 de 3 desfechos registrados — E4 sem desfecho não entra no denominador)", () => {
    expect(dashboard().funil_agendamento.taxa_comparecimento_pct).toBe(66.7);
  });
});

// ---- migration 0160: receita por anúncio (Meta Ads Fase D) ----

describe("fn_sales_dashboard — Fase D (receita por anúncio, migration 0160)", () => {
  const dashboard = () => fetchDashboard(MANAGER_F, ORG_F);

  it("⭐ ad-2(200000) > ad-1(150000, F1+F2 somados) — ordenado por receita_cents desc", () => {
    expect(dashboard().receita_por_anuncio).toEqual([
      {
        anuncio: "Campanha Inverno",
        ad_id: "ad-2",
        campaign_id: "cg-inverno",
        campaign_name: "CG Inverno",
        adset_id: "adset-b",
        adset_name: "Conjunto B",
        leads: 1,
        vendas: 1,
        agendamentos: 1,
        receita_cents: 200_000,
      },
      {
        anuncio: "Promoção de Verão",
        ad_id: "ad-1",
        campaign_id: "cg-verao",
        campaign_name: "CG Verão",
        adset_id: "adset-a",
        adset_name: "Conjunto A",
        leads: 2,
        vendas: 2,
        agendamentos: 1,
        receita_cents: 150_000,
      },
    ]);
  });

  it("⭐ Fase E3: LEAD_F1 remarcado (2 meeting_scheduled) não duplica leads/vendas/agendamentos do ad-1", () => {
    const ad1 = dashboard().receita_por_anuncio.find((a) => a.ad_id === "ad-1")!;
    // F1+F2 = 2 leads, não 3 — a remarcação de F1 não vira um segundo lead.
    expect(ad1.leads).toBe(2);
    expect(ad1.vendas).toBe(2);
    // agendamentos conta LEADS com pelo menos um meeting_scheduled, não
    // ocorrências — F1 tem 2 e F2 tem 0 → agendamentos do ad-1 é 1, não 2.
    expect(ad1.agendamentos).toBe(1);
  });

  it("headline de ad-1 vem de QUALQUER linha do grupo (F1 tem headline, F2 não) — max() não gera duas linhas", () => {
    const anuncios = dashboard().receita_por_anuncio;
    expect(anuncios.filter((a) => a.ad_id === "ad-1")).toHaveLength(1);
  });

  it("F4 (sem ad_id, lead orgânico) NÃO aparece em receita_por_anuncio — só 2 grupos, não 3", () => {
    expect(dashboard().receita_por_anuncio).toHaveLength(2);
  });
});

// ---- migration 0166: "cliente já existente" Fase 5 (leads_total exclui existing_customer + LTV/recompra) ----

describe("fn_sales_dashboard — Fase 5 (cliente já existente, migration 0166)", () => {
  const dashboard = () => fetchDashboard(MANAGER_G, ORG_G);

  it("⭐ leads_total=2, não 3 — LEAD_G4 (existing_customer) não conta, mesmo criado na janela", () => {
    expect(dashboard().kpis.leads_total).toBe(2);
  });

  it("vendas=2, receita_total_cents=300000 — só os won FECHADOS na janela (LEAD_G2 fechou FORA, não entra aqui)", () => {
    const k = dashboard().kpis;
    expect(k.vendas).toBe(2);
    expect(k.receita_total_cents).toBe(300_000);
  });

  it("⭐ ltv_medio_cents=175000 — LIFETIME: soma as 2 compras de G1 (100000+50000) mesmo a 2ª sendo FORA da janela", () => {
    // clientes: G1 (150000, 2 vendas) + G2 (200000, 1 venda) → média (150000+200000)/2 = 175000.
    expect(dashboard().kpis.ltv_medio_cents).toBe(175_000);
  });

  it("⭐ taxa_recompra_pct=50 — 1 de 2 clientes (G1) tem mais de uma venda, contando a de FORA da janela", () => {
    expect(dashboard().kpis.taxa_recompra_pct).toBe(50);
  });
});
