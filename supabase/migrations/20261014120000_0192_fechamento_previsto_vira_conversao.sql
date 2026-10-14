-- 0192_fechamento_previsto_vira_conversao — a previsão vira data real ao
-- ganhar, continua editável.
--
-- Pedido explícito do dono do produto: hoje `expected_close_date`
-- ("Fechamento previsto") é só uma previsão manual — negócio aberto, sem
-- ligação nenhuma com o fechamento de verdade. `closed_at` (gravado pelo
-- trigger `fn_crm_lead_close_on_stage`, nunca editável à mão) já é a data
-- REAL do fechamento, mas o card não expõe isso em lugar nenhum editável —
-- quem quisesse corrigir "na verdade fechamos um dia antes" não tinha onde.
--
-- O conserto: no instante em que o negócio vira GANHO, `expected_close_date`
-- passa a valer como "data de conversão" — herda `closed_at` automaticamente
-- — e continua sendo a MESMA coluna editável de sempre, então corrigir um
-- erro é só editar o campo do card, sem tocar em `closed_at` (que continua
-- imutável, é o registro de auditoria de quando o trigger rodou). Enquanto
-- o negócio está aberto, nada muda — é previsão, edita livre.
--
-- `fn_crm_lead_close_on_stage` só sobrescreve na TRANSIÇÃO pra won (a guarda
-- already existente no topo da função retorna cedo quando stage/status não
-- mudou), então editar o campo depois de ganho nunca é desfeito por este
-- trigger — ele não roda de novo pra um save que não mexe em stage/status.
--
-- Os relatórios (`fn_sales_dashboard`) seguem essa mesma data a partir de
-- agora — todo "data de conversão"/filtro de venda no período passa a usar
-- `coalesce(expected_close_date, closed_at)` em vez de só `closed_at`. O
-- fallback pro `closed_at` cobre os negócios já ganhos ANTES desta migration
-- (coberto pelo backfill abaixo, mas o coalesce fica como rede de segurança
-- pra qualquer linha que escape do backfill num clone).
--
-- Backfill seguro: só PREENCHE null com o valor que já é verdade
-- (`closed_at`) — nunca sobrescreve um valor que alguém já tenha editado.
update public.crm_leads
set expected_close_date = closed_at::date
where status = 'won' and expected_close_date is null;

create or replace function public.fn_crm_lead_close_on_stage() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_is_won  boolean;
  v_is_lost boolean;
begin
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.status   is not distinct from old.status then
    return new;
  end if;

  select is_won, is_lost into v_is_won, v_is_lost
    from public.crm_stages where id = new.stage_id;

  if v_is_won then
    new.status := 'won';
    new.closed_at := coalesce(new.closed_at, now());
    -- "Fechamento previsto" vira "data de conversão" na transição pra
    -- ganho — a partir daqui o campo continua editável normalmente (esta
    -- função não roda de novo pra um save que não mexe em stage/status).
    new.expected_close_date := new.closed_at::date;
  elsif v_is_lost then
    new.status := 'lost';
    new.closed_at := coalesce(new.closed_at, now());
  else
    if tg_op = 'UPDATE' and old.status in ('won','lost') then
      new.status := 'open';
      new.closed_at := null;
    end if;
  end if;
  return new;
end$$;

create or replace function public.fn_sales_dashboard(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_pipeline_id uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
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
    select date_trunc('day', coalesce(expected_close_date::timestamptz, closed_at)) as dia, count(*) as convertidos
    from public.crm_leads
    where organization_id = p_org
      and status = 'won'
      and coalesce(expected_close_date::timestamptz, closed_at) >= p_from
      and coalesce(expected_close_date::timestamptz, closed_at) < p_to
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
    select
      id, title, status, value_cents, created_at, closed_at, source, custom_fields, source_metadata,
      case when status = 'won' then coalesce(expected_close_date::timestamptz, closed_at) else null end as data_conversao
    from public.crm_leads
    where organization_id = p_org
      and status <> 'existing_customer'
      and (p_pipeline_id is null or pipeline_id = p_pipeline_id)
      and (p_source is null or source = p_source)
      and (
        (created_at >= p_from and created_at < p_to)
        or (status = 'won' and coalesce(expected_close_date::timestamptz, closed_at) >= p_from and coalesce(expected_close_date::timestamptz, closed_at) < p_to)
      )
  ),
  kpis as (
    select
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads_total,
      count(*) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ), 0) as receita_total_cents,
      round(avg(value_cents) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ))::bigint as valor_medio_cents,
      -- Duração do ciclo de venda usa `closed_at` (preciso), NÃO
      -- `data_conversao` (pode ter sido corrigida pra outro dia depois) — são
      -- perguntas diferentes: "em que dia contar esta venda" x "quanto tempo
      -- o ciclo levou de verdade". Uma correção de atribuição de dia não deve
      -- inventar/apagar tempo real de decisão.
      avg(extract(epoch from (closed_at - created_at)) / 86400) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ) as tempo_conversao_medio_dias
    from base
  ),
  origem as (
    select
      source,
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads,
      count(*) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ), 0) as receita_cents
    from base
    group by source
  ),
  servico as (
    select
      custom_fields->>'produto_interesse' as servico,
      count(*) filter (where created_at >= p_from and created_at < p_to) as leads,
      count(*) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
      ) as vendas,
      coalesce(sum(value_cents) filter (
        where status = 'won' and data_conversao >= p_from and data_conversao < p_to
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
      max(m.ad_name) as ad_name,
      max(m.campaign_id) as campaign_id,
      max(m.campaign_name) as campaign_name,
      max(m.adset_id) as adset_id,
      max(m.adset_name) as adset_name,
      count(*) filter (where b.created_at >= p_from and b.created_at < p_to) as leads,
      count(*) filter (
        where b.status = 'won' and b.data_conversao >= p_from and b.data_conversao < p_to
      ) as vendas,
      coalesce(sum(b.value_cents) filter (
        where b.status = 'won' and b.data_conversao >= p_from and b.data_conversao < p_to
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
  -- Uma linha por lead vendido no período — o que a lista pede. Mesmo filtro
  -- de `kpis.vendas`/`receita_total_cents`, só sem agregar.
  vendas_lista as (
    select
      b.id,
      b.title,
      b.value_cents,
      b.custom_fields->>'produto_interesse' as servico,
      b.created_at,
      b.closed_at,
      b.data_conversao
    from base b
    where b.status = 'won' and b.data_conversao >= p_from and b.data_conversao < p_to
  ),
  -- LIFETIME de propósito — sem filtro de p_from/p_to (ver comentário do
  -- cabeçalho da 0166). Só conta quem tem `won` de verdade: cliente
  -- reconhecido na mão (Fase 3) sem nenhuma venda registrada aqui não tem
  -- valor pra somar.
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
          'anuncio', coalesce(a.ad_name, a.ad_headline, a.ad_id),
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
    ), '[]'::jsonb),
    'vendas_lista', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'lead_id', v.id,
          'nome', v.title,
          'servico', coalesce(v.servico, 'Não informado'),
          'valor_cents', v.value_cents,
          'data', to_char(v.created_at, 'YYYY-MM-DD'),
          'data_conversao', to_char(v.data_conversao, 'YYYY-MM-DD'),
          -- Mesma razão do kpis.tempo_conversao_medio_dias acima: duração
          -- real do ciclo usa closed_at, não a data de conversão (que pode
          -- ter sido corrigida pra outro dia).
          'tempo_decisao_dias', round(extract(epoch from (v.closed_at - v.created_at)) / 86400)
        ) order by v.data_conversao desc
      )
      from vendas_lista v
    ), '[]'::jsonb)
  );
$function$;
