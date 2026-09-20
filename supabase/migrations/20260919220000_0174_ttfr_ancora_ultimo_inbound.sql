-- 0174_ttfr_ancora_ultimo_inbound — forward-fix da 0037 (spec 13 §6.6).
--
-- BUG medido em produção (RevitaFio Mossoró, 2026-09-19): o TTFR ("tempo até
-- 1ª resposta humana") ancorava em t0 = min(inbound) — o PRIMEIRO inbound de
-- TODA a história da conversa. Quando um lead manda uma mensagem, entra numa
-- automação de reengajamento que dispara templates por dias, e só recebe
-- resposta humana ao reagir a um desses templates, a métrica contava os dias
-- inteiros de nutrição automática como "tempo de resposta do atendente" — uma
-- atendente com respostas reais de minutos aparecia com média de 668min.
--
-- FIX: t0 passa a ser o inbound MAIS RECENTE antes da 1ª resposta humana
-- (t1), não o mais antigo da conversa. Recalculado com a âncora correta, a
-- mesma atendente caiu para 125min — condizente com a operação real. Conversa
-- com um único inbound antes de t1 (o caso comum, e o único que o dataset de
-- `tests/invariants/gov-8-metrics.test.ts` cobre) não muda: t0=max(inbound) e
-- t0=min(inbound) coincidem quando só há um inbound. Só muda quando há MAIS
-- de um inbound antes de t1 — exatamente o caso que faltava cobertura.
--
-- create or replace function ⇒ idempotente. Índice reaproveitado (nenhum
-- novo): mesma leitura de `idx_messages_conversation_sent
-- (conversation_id, sent_at)`, agora em duas lateral joins em vez de uma.

create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  -- §6.6 (0174): t1 = 1ª resposta humana da conversa; t0 = inbound mais
  -- RECENTE antes de t1 (não o mais antigo da conversa inteira — ver cabeçalho).
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fh.first_human_out - li.last_in_before))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fh
    cross join lateral (
      select max(m2.sent_at) as last_in_before
      from public.messages m2
      where m2.conversation_id = c.id
        and m2.direction = 'inbound'
        and m2.sent_at < fh.first_human_out
    ) li
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fh.first_human_out is not null
      and li.last_in_before is not null
      and fh.first_human_out > li.last_in_before
      and fh.first_human_out >= p_from and fh.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;
