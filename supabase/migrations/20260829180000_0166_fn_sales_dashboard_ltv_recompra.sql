-- 0166_fn_sales_dashboard_ltv_recompra — "Cliente já existente", Fase 5:
-- fecha o roteiro (Fase 1 schema, Fase 2 automático, Fase 3 manual, Fase 4
-- some do board). Duas mudanças no MESMO `create or replace`:
--
-- 1. Todo "leads" contado por `created_at` (leads_total, leads_por_dia,
--    receita_por_origem/servico/anuncio) agora EXCLUI status='existing_customer'
--    — é exatamente o problema original que motivou a feature inteira:
--    reconhecer alguém como cliente de antes não pode inflar "quantos leads
--    entraram este mês". `status='won'` nunca coincide com
--    `existing_customer` (são desfechos mutuamente exclusivos), então excluir
--    de `base` não tira NADA do lado de vendas/receita.
--
-- 2. Duas métricas novas, LIFETIME de propósito (não filtradas por
--    `p_from`/`p_to`, só por `p_org`/`p_pipeline_id`/`p_source`): "taxa de
--    recompra" (recorrência é uma pergunta sobre a vida inteira do cliente,
--    não sobre um período) e "LTV médio" — que já seriam idênticas a
--    `valor_medio_cents` se ficassem presas à janela do relatório. Contam só
--    quem tem pelo menos 1 negócio `won` registrado no CRM — cliente
--    reconhecido manualmente sem venda no sistema não tem valor pra somar.
create or replace function public.fn_sales_dashboard(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_pipeline_id uuid default null,
  p_source text default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  leads_criados_por_dia as (
    select date_trunc('day', created_at) as dia, count(*) as criados
    from public.crm_leads
    where organization_id = p_org
      and created_at >= p_from and created_at < p_to
      and status <> 'existing_customer'
      and (p_pipeline_id is null or pipeline_id = p_pipeline_id)
      and (p_source is null or source = p_source)
    group by 1
  ),
  leads_convertidos_por_dia as (
    select date_trunc('day', closed_at) as dia, count(*) as convertidos
    from public.crm_leads
    where organization_id = p_org
      and status = 'won'
      and closed_at >= p_from and closed_at < p_to
      and (p_pipeline_id is null or pipeline_id = p_pipeline_id)
      and (p_source is null or source = p_source)
    group by 1
  ),
  dias as (
    select generate_series(
      date_trunc('day', p_from),
      date_trunc('day', p_to - interval '1 microsecond'),
      interval '1 day'
    ) as dia
  ),
  base as (
    select id, status, value_cents, created_at, closed_at, source, custom_fields, source_metadata
    from public.crm_leads
    where organization_id = p_org
      and status <> 'existing_customer'
      and (p_pipeline_id is null or pipeline_id = p_pipeline_id)
      and (p_source is null or source = p_source)
      and (
        (created_at >= p_from and created_at < p_to)
        or (status = 'won' and closed_at >= p_from and closed_at < p_to)
      )
  ),
  kpis as (
    select
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads_total,
      count(*) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ), 0) as receita_total_cents,
      round(avg(value_cents) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ))::bigint as valor_medio_cents,
      avg(extract(epoch from (closed_at - created_at)) / 86400) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ) as tempo_conversao_medio_dias
    from base
  ),
  origem as (
    select
      source,
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads,
      count(*) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ), 0) as receita_cents
    from base
    group by source
  ),
  servico as (
    select
      custom_fields->>'produto_interesse' as servico,
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads,
      count(*) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and closed_at >= p_from and closed_at < p_to
      ), 0) as receita_cents
    from base
    group by 1
  ),
  objecoes as (
    select
      a.payload->>'code' as motivo,
      count(*) as quantidade
    from public.crm_lead_activities a
    join public.crm_leads l on l.id = a.lead_id
    where a.organization_id = p_org
      and a.type = 'objection'
      and a.performed_at >= p_from and a.performed_at < p_to
      and (p_pipeline_id is null or l.pipeline_id = p_pipeline_id)
      and (p_source is null or l.source = p_source)
    group by 1
  ),
  funil_agendamento as (
    select
      count(distinct a.lead_id) filter (where a.type = 'meeting_scheduled') as agendados,
      count(distinct a.lead_id) filter (
        where a.type = 'meeting_outcome' and a.payload->>'outcome' = 'attended'
      ) as compareceram,
      count(distinct a.lead_id) filter (
        where a.type = 'meeting_outcome' and a.payload->>'outcome' = 'no_show'
      ) as nao_compareceram,
      count(distinct a.lead_id) filter (
        where a.type = 'meeting_outcome' and a.payload->>'outcome' = 'attended'
          and l.status = 'won'
      ) as compareceram_e_fecharam
    from public.crm_lead_activities a
    join public.crm_leads l on l.id = a.lead_id
    where a.organization_id = p_org
      and a.type in ('meeting_scheduled', 'meeting_outcome')
      and a.performed_at >= p_from and a.performed_at < p_to
      and (p_pipeline_id is null or l.pipeline_id = p_pipeline_id)
      and (p_source is null or l.source = p_source)
  ),
  anuncio as (
    select
      b.source_metadata->>'ad_id' as ad_id,
      max(b.source_metadata->>'ad_headline') as ad_headline,
      max(m.campaign_id) as campaign_id,
      max(m.campaign_name) as campaign_name,
      max(m.adset_id) as adset_id,
      max(m.adset_name) as adset_name,
      count(*) filter (where b.created_at >= p_from and b.created_at < p_to) as leads,
      count(*) filter (
        where b.status = 'won' and b.closed_at >= p_from and b.closed_at < p_to
      ) as vendas,
      coalesce(sum(b.value_cents) filter (
        where b.status = 'won' and b.closed_at >= p_from and b.closed_at < p_to
      ), 0) as receita_cents,
      count(*) filter (
        where exists (
          select 1 from public.crm_lead_activities act
          where act.lead_id = b.id
            and act.type = 'meeting_scheduled'
            and act.performed_at >= p_from and act.performed_at < p_to
        )
      ) as agendamentos
    from base b
    left join public.meta_ads_ad_metadata m
      on m.organization_id = p_org and m.ad_id = b.source_metadata->>'ad_id'
    where b.source_metadata ? 'ad_id'
    group by 1
  ),
  -- LIFETIME de propósito — sem filtro de p_from/p_to (ver comentário do
  -- cabeçalho). Só conta quem tem `won` de verdade: cliente reconhecido na
  -- mão (Fase 3) sem nenhuma venda registrada aqui não tem valor pra somar.
  clientes as (
    select
      l.contact_id,
      count(*) as vendas_do_cliente,
      sum(l.value_cents) as ltv_cents
    from public.crm_leads l
    where l.organization_id = p_org
      and l.status = 'won'
      and l.contact_id is not null
      and (p_pipeline_id is null or l.pipeline_id = p_pipeline_id)
      and (p_source is null or l.source = p_source)
    group by l.contact_id
  )
  select jsonb_build_object(
    'kpis', (
      select jsonb_build_object(
        'leads_total', k.leads_total,
        'vendas', k.vendas,
        'receita_total_cents', k.receita_total_cents,
        'valor_medio_cents', k.valor_medio_cents,
        'conversao_pct', case when k.leads_total > 0
          then round((k.vendas::numeric / k.leads_total) * 100, 1)
          else null end,
        'tempo_conversao_medio_dias', round(k.tempo_conversao_medio_dias::numeric, 1),
        'ltv_medio_cents', (select round(avg(c.ltv_cents))::bigint from clientes c),
        'taxa_recompra_pct', (
          select case when count(*) > 0
            then round((count(*) filter (where c.vendas_do_cliente > 1)::numeric / count(*)) * 100, 1)
            else null end
          from clientes c
        )
      )
      from kpis k
    ),
    'leads_por_dia', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'dia', to_char(d.dia, 'YYYY-MM-DD'),
          'criados', coalesce(lc.criados, 0),
          'convertidos', coalesce(lv.convertidos, 0)
        ) order by d.dia
      )
      from dias d
      left join leads_criados_por_dia lc on lc.dia = d.dia
      left join leads_convertidos_por_dia lv on lv.dia = d.dia
    ), '[]'::jsonb),
    'receita_por_origem', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'origem', o.source,
          'leads', o.leads,
          'vendas', o.vendas,
          'receita_cents', o.receita_cents
        ) order by o.receita_cents desc, o.source
      )
      from origem o
    ), '[]'::jsonb),
    'receita_por_servico', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'servico', coalesce(s.servico, 'Não informado'),
          'leads', s.leads,
          'vendas', s.vendas,
          'receita_cents', s.receita_cents
        ) order by s.receita_cents desc, s.servico
      )
      from servico s
    ), '[]'::jsonb),
    'principais_objecoes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'motivo', coalesce(o2.motivo, 'other'),
          'quantidade', o2.quantidade
        ) order by o2.quantidade desc, o2.motivo
      )
      from objecoes o2
    ), '[]'::jsonb),
    'funil_agendamento', (
      select jsonb_build_object(
        'agendados', f.agendados,
        'compareceram', f.compareceram,
        'nao_compareceram', f.nao_compareceram,
        'compareceram_e_fecharam', f.compareceram_e_fecharam,
        'taxa_comparecimento_pct', case when (f.compareceram + f.nao_compareceram) > 0
          then round((f.compareceram::numeric / (f.compareceram + f.nao_compareceram)) * 100, 1)
          else null end
      )
      from funil_agendamento f
    ),
    'receita_por_anuncio', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'anuncio', coalesce(a.ad_headline, a.ad_id),
          'ad_id', a.ad_id,
          'campaign_id', a.campaign_id,
          'campaign_name', a.campaign_name,
          'adset_id', a.adset_id,
          'adset_name', a.adset_name,
          'leads', a.leads,
          'vendas', a.vendas,
          'agendamentos', a.agendamentos,
          'receita_cents', a.receita_cents
        ) order by a.receita_cents desc, a.ad_id
      )
      from anuncio a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from anon;
grant execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
