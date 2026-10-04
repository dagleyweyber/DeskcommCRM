-- 0180: mais sinais pro Meta CAPI — etapa dispara evento + aviso de esgotamento
--
-- Achado investigando a RevitaFio Mossoró a pedido do usuário: 8 de 14
-- tentativas de Purchase pro Meta CAPI falharam (57%), e o handler sempre
-- devolvia status "ok" pro dispatcher do event_log mesmo na falha — por isso
-- o reenvio com backoff que o event_log JÁ TEM (lib/event-log/drain.ts) nunca
-- era acionado. Esta migration cobre o schema de duas peças dessa correção:
--
-- 1. `crm_stages.meta_capi_event_name` — deixa o tenant marcar qual etapa
--    dispara qual evento padrão do Meta (ex.: "Avaliação Agendada" → Schedule),
--    do mesmo jeito que já marca `is_won`/`is_lost`. Generaliza pra qualquer
--    sinal futuro sem precisar de migration nova a cada vez.
-- 2. Novo `kind` em `agent_inbox_items` pra avisar quando um envio esgota as
--    tentativas de reenvio e ainda assim falha — sem isso, depois de ~31min
--    de tentativa a venda/sinal perdido volta a ficar invisível.

alter table public.crm_stages
  add column if not exists meta_capi_event_name text;

alter table public.crm_stages
  drop constraint if exists crm_stages_meta_capi_event_name_check;

alter table public.crm_stages
  add constraint crm_stages_meta_capi_event_name_check check (
    meta_capi_event_name is null or meta_capi_event_name in (
      'Schedule', 'Lead', 'CompleteRegistration', 'InitiateCheckout', 'Contact'
    )
  );

-- Reconstrução completa da constraint (doutrina do repo: uma migration por
-- reconstrução, lista INTEIRA, nunca só o valor novo — issue #159,
-- tests/unit/kind-check-migration-x-baseline.test.ts).
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
    'meta_capi_send_exhausted',
    'other'
  ));

notify pgrst, 'reload schema';
