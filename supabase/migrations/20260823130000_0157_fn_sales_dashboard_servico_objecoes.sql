-- 0157_fn_sales_dashboard_servico_objecoes — Dashboard de Vendas, Fase 2:
-- Receita por Serviço + Principais Objeções.
--
-- Assinatura NÃO muda (uuid, timestamptz, timestamptz, uuid, text) — os dois
-- blocos novos entram no MESMO retorno jsonb da 0156, `create or replace`
-- puro, sem drop.
--
-- receita_por_servico: agrupa a MESMA CTE `base` (já filtrada por
-- período/pipeline/origem) por custom_fields->>'produto_interesse'. Esse
-- campo virou select configurável (migration nenhuma pro schema — vive em
-- crm_pipelines.settings.service_options, jsonb, sem coluna nova) na tela de
-- Configurações › Funis; lead com valor livre de antes continua agrupando
-- pelo próprio texto, só não some do relatório.
--
-- principais_objecoes: nova entrada em crm_lead_activities (type='objection',
-- vocabulário aberto — sem CHECK constraint na tabela, então nenhuma migration
-- pro tipo em si). `payload->>'code'` carrega o motivo canônico
-- (CANONICAL_OBJECTIONS); `reason` carrega a frase legível pra timeline, não
-- é isso que o relatório agrupa (fragmentaria por causa do detalhe opcional
-- que o usuário digita).
create index if not exists idx_crm_lead_activities_org_objection
  on public.crm_lead_activities (organization_id, performed_at)
  where type = 'objection';

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
    select status, value_cents, created_at, closed_at, source, custom_fields
    from public.crm_leads
    where organization_id = p_org
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
        'tempo_conversao_medio_dias', round(k.tempo_conversao_medio_dias::numeric, 1)
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
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from anon;
grant execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
