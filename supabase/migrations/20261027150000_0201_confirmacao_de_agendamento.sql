-- ============================================================================
-- 0201 — CONFIRMAÇÃO AUTOMÁTICA DE AGENDAMENTO
--
-- Pedido do dono do produto (2026-10-27): quando a automação de confirmação
-- está ativa e o cliente responde "confirmo", o compromisso aparece
-- CONFIRMADO na Agenda sozinho; se responde que não, aparece NÃO CONFIRMADO
-- e a equipe é avisada (o horário continua reservado até a recepção
-- remarcar/cancelar — decisão do dono). E toda automação precisa enxergar a
-- data e a hora de TODO compromisso da Agenda.
--
-- ─── O que estava errado ─────────────────────────────────────────────────────
-- `fn_due_appointment_reminders` (0169/0199) procurava a atividade
-- `meeting_scheduled` na timeline do NEGÓCIO, não o compromisso. Efeitos:
--   • cliente sem negócio aberto (o paciente que volta para a 5ª sessão de
--     laser) nunca recebia lembrete — `fecharOLaco` não emite atividade sem
--     negócio;
--   • só existia "no dia, às 8h".
-- E a resposta ao botão do modelo chegava ao inbox, mas nada a ligava ao
-- compromisso: o webhook descartava `context.id` e o envio não guardava qual
-- compromisso era.
--
-- ─── O desenho ───────────────────────────────────────────────────────────────
--  1. A automação ganha QUANDO enviar (`timing_kind` + `timing_value`):
--     `day_of_8am` (o de sempre, default — automações existentes não mudam),
--     `days_before` (N dias antes, às 8h) e `hours_before` (N horas antes).
--  2. A automação ganha QUAL BOTÃO do modelo confirma e qual desmarca
--     (`confirm_button_text`/`decline_button_text`). Preenchido = é uma
--     automação de CONFIRMAÇÃO: só manda para compromisso ainda "Agendado".
--  3. A trava "uma automação ativa por serviço" (0199) passa a ser por
--     serviço E momento: confirmação 1 dia antes + lembrete no dia, do mesmo
--     serviço, é o caso real — e continuam sem envio em dobro.
--  4. O envio guarda o compromisso (`appointment_id`) e é achado pela
--     mensagem respondida (`external_id`, índice novo).
--  5. `fn_due_appointment_reminders` lê `calendar_appointments` direto.
--     MESMA assinatura e MESMAS colunas de saída: a imagem antiga do app
--     continua funcionando entre aplicar a migration e o deploy. A coluna
--     `activity_id` passa a carregar o id do COMPROMISSO (é a chave de
--     dedup; remarcar = compromisso novo = envio novo). Envio já feito com a
--     chave antiga (id da atividade) continua contando — ninguém recebe a
--     mesma mensagem duas vezes na virada.
--  6. `calendar_appointments.client_responded_at` — quando o cliente
--     respondeu (a grade mostra que foi o cliente, não a recepção).
--  7. Aviso na Central `appointment_declined`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1–2. Quando enviar + qual botão confirma
-- ---------------------------------------------------------------------------
alter table public.whatsapp_template_automations
  add column if not exists timing_kind text not null default 'day_of_8am',
  add column if not exists timing_value integer,
  add column if not exists confirm_button_text text,
  add column if not exists decline_button_text text;

alter table public.whatsapp_template_automations
  drop constraint if exists whatsapp_template_automations_timing_check;
alter table public.whatsapp_template_automations
  add constraint whatsapp_template_automations_timing_check check (
    (timing_kind = 'day_of_8am' and timing_value is null)
    or (timing_kind = 'days_before' and timing_value between 1 and 7)
    or (timing_kind = 'hours_before' and timing_value between 1 and 72)
  );

comment on column public.whatsapp_template_automations.timing_kind is
  'Quando enviar em relação ao compromisso: day_of_8am (no dia, 8h), days_before (N dias antes, 8h), hours_before (N horas antes). Migration 0201.';
comment on column public.whatsapp_template_automations.confirm_button_text is
  'Texto do botão de resposta rápida do modelo que CONFIRMA presença. Preenchido (ou decline) = automação de confirmação.';

-- ---------------------------------------------------------------------------
-- 3. Uma automação ativa por (gatilho, serviço, momento)
-- ---------------------------------------------------------------------------
-- Afrouxa a trava da 0199 (acrescenta colunas à chave): nenhum dado existente
-- a viola, então não há auto-cura a fazer antes.
drop index if exists public.uniq_automacao_ativa_por_servico;
create unique index if not exists uniq_automacao_ativa_por_servico_e_momento
  on public.whatsapp_template_automations (
    organization_id, trigger_kind,
    coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    timing_kind, coalesce(timing_value, 0)
  )
  where status = 'active';

-- ---------------------------------------------------------------------------
-- 4. O envio sabe qual compromisso e é achado pela mensagem respondida
-- ---------------------------------------------------------------------------
alter table public.whatsapp_template_automation_sends
  add column if not exists appointment_id uuid references public.calendar_appointments(id) on delete set null;

create index if not exists whatsapp_template_automation_sends_external_idx
  on public.whatsapp_template_automation_sends (organization_id, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- 6. Quando o cliente respondeu
-- ---------------------------------------------------------------------------
alter table public.calendar_appointments
  add column if not exists client_responded_at timestamptz;

comment on column public.calendar_appointments.client_responded_at is
  'Quando o CLIENTE respondeu à confirmação automática (botão do modelo). Nulo = status mudado pela equipe ou ainda sem resposta. Migration 0201.';

-- ---------------------------------------------------------------------------
-- 5. fn_due_appointment_reminders lê a Agenda (mesma assinatura/saída)
-- ---------------------------------------------------------------------------
create or replace function public.fn_due_appointment_reminders(
  p_organization_id uuid,
  p_automation_id uuid,
  p_now timestamptz default now()
)
returns table (
  lead_id uuid,
  contact_id uuid,
  activity_id uuid,
  scheduled_at timestamptz,
  display_name text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with minha as (
    select a.event_type_id,
           a.timing_kind,
           coalesce(a.timing_value, 0) as timing_value,
           (a.confirm_button_text is not null or a.decline_button_text is not null) as pede_confirmacao
      from public.whatsapp_template_automations a
     where a.id = p_automation_id and a.organization_id = p_organization_id
  ),
  fuso as (
    select coalesce(
      (select s.default_schedule->>'timezone' from public.calendar_settings s where s.organization_id = p_organization_id),
      'America/Sao_Paulo'
    ) as tz
  ),
  candidatos as (
    -- Só o que ainda vai acontecer, numa janela que cobre o maior "antes" (7 dias).
    select c.id, c.contact_id, c.starts_at, c.event_type_id
      from public.calendar_appointments c
      cross join minha m
     where c.organization_id = p_organization_id
       and c.starts_at > p_now
       and c.starts_at <= p_now + interval '8 days'
       and c.status in ('pending', 'confirmed')
       -- confirmação só faz sentido para quem ainda não confirmou
       and (not m.pede_confirmacao or c.status = 'pending')
  ),
  devidos as (
    select k.*,
           case m.timing_kind
             when 'hours_before' then k.starts_at - make_interval(hours => m.timing_value)
             when 'days_before' then
               (((k.starts_at at time zone f.tz)::date - m.timing_value) + time '08:00') at time zone f.tz
             else
               ((k.starts_at at time zone f.tz)::date + time '08:00') at time zone f.tz
           end as enviar_em
      from candidatos k
      cross join minha m
      cross join fuso f
  )
  select
    (select l.id
       from public.crm_leads l
      where l.organization_id = p_organization_id
        and l.contact_id = d.contact_id
        and l.status = 'open'
      order by l.last_activity_at desc nulls last, l.created_at desc
      limit 1) as lead_id,
    d.contact_id,
    d.id as activity_id,
    d.starts_at as scheduled_at,
    coalesce(ct.display_name, ct.name, ct.phone_number, 'Sem nome') as display_name
  from devidos d
  join public.contacts ct on ct.id = d.contact_id
  where p_now >= d.enviar_em
    and (
      -- automação de UM serviço: só compromissos desse serviço
      (
        (select m.event_type_id from minha m) is not null
        and d.event_type_id = (select m.event_type_id from minha m)
      )
      or
      -- automação de TODOS os serviços: tudo, menos o serviço que tem automação
      -- própria ativa NO MESMO MOMENTO (o específico vence — senão o cliente
      -- receberia as duas mensagens)
      (
        (select m.event_type_id from minha m) is null
        and not exists (
          select 1 from public.whatsapp_template_automations o, minha m
           where o.organization_id = p_organization_id
             and o.trigger_kind = 'appointment_reminder'
             and o.status = 'active'
             and o.event_type_id is not null
             and o.event_type_id = d.event_type_id
             and o.timing_kind = m.timing_kind
             and coalesce(o.timing_value, 0) = m.timing_value
        )
      )
    )
    and not exists (
      select 1 from public.whatsapp_template_automation_sends s
       where s.automation_id = p_automation_id
         and (
           s.occurrence_key = d.id::text
           -- chave antiga (0169/0199): id da atividade `meeting_scheduled` deste compromisso
           or s.occurrence_key in (
             select act.id::text
               from public.crm_lead_activities act
              where act.organization_id = p_organization_id
                and act.source_module = 'agenda.agendamentos'
                and act.source_id::text = d.id::text
           )
         )
    );
$$;

revoke all on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Aviso na Central: cliente respondeu que não vem
-- ---------------------------------------------------------------------------
-- Reconstrução completa da constraint (doutrina do repo: lista INTEIRA, nunca
-- só o valor novo — issue #159, tests/unit/kind-check-migration-x-baseline.test.ts).
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
    'appointment_declined',
    'other'
  ));

notify pgrst, 'reload schema';
