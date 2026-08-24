-- 0158_fn_sales_dashboard_funil_agendamento — Dashboard de Vendas, Fase 3:
-- Funil real (Agendamento → Presença → Conversão).
--
-- Assinatura NÃO muda (uuid, timestamptz, timestamptz, uuid, text) — o bloco
-- novo entra no MESMO retorno jsonb da 0157, `create or replace` puro.
--
-- Onde won/lost não mostra o vazamento: um lead pode nunca ter sido marcado
-- como perdido e ainda assim ter sumido no meio do caminho — marcou visita e
-- não veio. `meeting_scheduled`/`meeting_outcome` são novas entradas em
-- crm_lead_activities (vocabulário aberto, sem CHECK na tabela — mesma porta
-- que `objection` abriu na Fase 2, nenhuma migration pro tipo em si).
--
-- Semântica de período: filtra por `performed_at` (quando a AÇÃO foi
-- registrada), igual a `objecoes` — não pela data agendada em si. "Quantos
-- agendamentos/presenças foram lançados neste período", consistente com o
-- resto da função (leads criados/fechados também são pela data do evento,
-- não de um campo de calendário).
--
-- `compareceram_e_fecharam` olha `l.status` ATUAL (não `closed_at` dentro do
-- período): a venda pode fechar depois da visita, fora da janela do
-- relatório, e exigir as duas datas no mesmo período subcontaria conversão
-- de propósito.
create index if not exists idx_crm_lead_activities_org_meeting
  on public.crm_lead_activities (organization_id, performed_at)
  where type in ('meeting_scheduled', 'meeting_outcome');

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
    )
  );
$$;

revoke all on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text) from anon;
grant execute on function public.fn_sales_dashboard(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
