-- 0155_fn_sales_dashboard — Dashboard de Vendas, Fase 1 (KPIs + gráficos com
-- dado que já existe em crm_leads: value_cents, closed_at, created_at, status,
-- source). Sem coluna nova, sem migração de dado — só agregação.
--
-- Mesma estratégia de escopo de 0037 (fn_attendant_metrics) e 0133
-- (fn_atrito_metrics): função SQL SECURITY INVOKER (default) — a RLS de
-- crm_leads (fn_can_view_lead) escopa DENTRO da função. agent ⇒ só os próprios
-- leads entram na agregação; manager+ ⇒ org inteira. organization_id = p_org
-- filtrado explicitamente em toda CTE por defesa em profundidade, mesmo com
-- RLS ativa. Nunca cross-tenant.
--
-- Janela semiaberta [p_from, p_to), igual ao resto do repo. Duas métricas de
-- data diferentes (created_at pra "leads criados", closed_at pra "vendas")
-- SEM tentar coorte: um lead criado antes da janela que fecha dentro dela
-- conta como venda mas não como lead no denominador — é a mesma simplificação
-- do relatório de referência que motivou esta feature, não um bug.
--
-- Índice novo: os dois existentes (idx_crm_leads_org_status_closed_owner, de
-- 0037) cobrem o filtro por status+closed_at; faltava um por created_at puro
-- (leads_total e a série por dia). value_cents é nullable — toda soma/média
-- usa coalesce/filter pra não estourar em org sem venda nenhuma.

create index if not exists idx_crm_leads_org_created_at
  on public.crm_leads (organization_id, created_at);

create or replace function public.fn_sales_dashboard(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz
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
    group by 1
  ),
  leads_convertidos_por_dia as (
    select date_trunc('day', closed_at) as dia, count(*) as convertidos
    from public.crm_leads
    where organization_id = p_org
      and status = 'won'
      and closed_at >= p_from and closed_at < p_to
    group by 1
  ),
  -- limite superior -1 microssegundo: p_to é exclusivo, então o dia de p_to só
  -- entra na série se alguma fração dele estiver de fato dentro da janela.
  dias as (
    select generate_series(
      date_trunc('day', p_from),
      date_trunc('day', p_to - interval '1 microsecond'),
      interval '1 day'
    ) as dia
  ),
  -- linhas relevantes pra qualquer um dos dois relógios (criado OU vendido na
  -- janela) — os FILTER abaixo recortam por métrica dentro desse conjunto.
  base as (
    select status, value_cents, created_at, closed_at, source
    from public.crm_leads
    where organization_id = p_org
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
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz) from anon;
grant execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
