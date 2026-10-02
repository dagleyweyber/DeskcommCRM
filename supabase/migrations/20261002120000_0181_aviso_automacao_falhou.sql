-- 0181: aviso na Central quando uma regra de automação falha
--
-- Revisão de capacidade pré-lançamento (pedido do usuário, "mais 5 clínicas"):
-- `lib/automation/engine.ts` já grava o resultado de cada rule run em
-- `automation_rule_runs` (status success/partial/failed), mas sempre devolve
-- `status:"ok"` ao dispatcher do event_log e nenhuma tela lê essa tabela — uma
-- regra de webhook ou WhatsApp que falha fica permanentemente invisível pro
-- dono do negócio. Mesma classe de achado que já motivou a 0180 (Meta CAPI),
-- mas SEM reenvio automático aqui: ao contrário de um Purchase pro Meta
-- (idempotente por event_id do lado de lá), reexecutar uma regra de
-- automação reenviaria webhook/mensagem de WhatsApp JÁ entregues com sucesso
-- em partes anteriores de uma run parcial — pior que a falha silenciosa
-- atual. Esta migration só cobre o schema do aviso; o reenvio automático
-- fica fora de escopo até existir idempotência por AÇÃO, não só por regra.

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
    'automation_rule_failed',
    'other'
  ));

notify pgrst, 'reload schema';
