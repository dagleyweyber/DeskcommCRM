-- 0175: alerta "IA parou de responder"
--
-- Achado auditando o CHANGELOG do fornecedor: eles corrigiram exatamente essa
-- classe de silêncio ("processamento que para de tentar agora aparece na
-- Central de avisos"). Confirmado ao vivo em produção que o mesmo buraco
-- existe aqui, e de forma mais grave: um agente publicado e ativo pode ficar
-- semanas sem responder ninguém (credencial ausente na versão publicada, ou
-- qualquer outra falha estrutural) sem NENHUM sinal em lugar nenhum — nem
-- Central de avisos, nem log que alguém leia rotineiramente.
--
-- fn_ia_organizacoes_silenciosas resolve "quem precisa de alerta agora" via
-- SQL (não method-chaining do Supabase JS — mesma doutrina já usada em
-- fn_due_appointment_reminders/fn_sales_dashboard): cruza agente publicado +
-- ativo contra credencial da versão publicada, e contra tráfego real recente
-- (mensagem inbound) sem nenhuma atividade correspondente
-- (ai_agent_runs/ai_invocations) na mesma janela.

create or replace function public.fn_ia_organizacoes_silenciosas(p_janela_minutos int default 60)
returns table(organization_id uuid, motivo text, agent_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with agentes_publicados as (
    select a.id as agent_id, a.organization_id, av.credential_id
    from public.ai_agents a
    join public.ai_agent_versions av on av.id = a.published_version_id
    where a.is_active = true
      and a.published_version_id is not null
      and a.archived_at is null
  ),
  sem_credencial as (
    select organization_id, 'sem_credencial'::text as motivo, agent_id
    from agentes_publicados
    where credential_id is null
  ),
  -- Mensagem precisa de pelo menos 5min de idade: dá tempo do pipeline
  -- assíncrono processar antes de julgar "silêncio" — senão o próprio
  -- atraso normal do fluxo vira alarme falso.
  trafego_recente as (
    select distinct organization_id
    from public.messages
    where direction = 'inbound'
      and created_at >= now() - (p_janela_minutos || ' minutes')::interval
      and created_at <= now() - interval '5 minutes'
  ),
  atividade_recente as (
    select organization_id from public.ai_agent_runs
      where created_at >= now() - (p_janela_minutos || ' minutes')::interval
        and is_dry_run = false
    union
    select organization_id from public.ai_invocations
      where created_at >= now() - (p_janela_minutos || ' minutes')::interval
  ),
  sem_atividade as (
    select ap.organization_id, 'sem_atividade'::text as motivo, ap.agent_id
    from agentes_publicados ap
    join trafego_recente t on t.organization_id = ap.organization_id
    where ap.credential_id is not null
      and ap.organization_id not in (select organization_id from atividade_recente)
  )
  select * from sem_credencial
  union all
  select * from sem_atividade;
$$;

revoke execute on function public.fn_ia_organizacoes_silenciosas(int) from public, anon;
grant execute on function public.fn_ia_organizacoes_silenciosas(int) to service_role;

-- Novo kind pra Central de Avisos — reconstrução completa da constraint
-- (doutrina do repo: uma migration por reconstrução, lista INTEIRA, nunca só
-- o valor novo — issue #159, tests/unit/kind-check-migration-x-baseline.test.ts).
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'ia_sem_resposta',
    'other'
  ));

notify pgrst, 'reload schema';
