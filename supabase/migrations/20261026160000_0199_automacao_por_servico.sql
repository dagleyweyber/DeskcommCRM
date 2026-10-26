-- 0199_automacao_por_servico — o lembrete de agendamento passa a saber QUAL serviço.
--
-- Achado com a B'Laser Parnamirim (2026-10-26): a clínica tem dois serviços com modelos de
-- mensagem diferentes (depilação a laser e estética corporal) e o gatilho de lembrete era
-- cego ao serviço — toda automação ativa mandava o seu modelo para TODO agendamento do dia.
-- Duas automações ativas = cada cliente recebia as duas mensagens, uma delas errada.
--
-- A informação que faltava já existe: a Agenda tem o catálogo de serviços
-- (`calendar_event_types`) e cada compromisso guarda o seu (`event_type_id`). A atividade
-- `meeting_scheduled` que a Agenda emite no funil carrega `source_id` = id do compromisso,
-- então dá para ir da atividade ao serviço.
--
-- ─── O desenho ───────────────────────────────────────────────────────────────
--  1. A automação ganha `event_type_id` (opcional). NULL = "todos os serviços", que é o
--     comportamento de sempre — as automações existentes não mudam.
--  2. UMA automação ATIVA por (organização, gatilho, serviço): índice único parcial. É a
--     trava contra envio duplo.
--  3. A automação de UM serviço só dispara para agendamentos DELE. A de "todos" dispara
--     para tudo MENOS o serviço que já tem automação própria ativa (o específico vence).
--  4. Agendamento CANCELADO na Agenda não recebe lembrete. Cancelar na Agenda não emite
--     atividade no funil, então antes a atividade `meeting_scheduled` seguia valendo e o
--     cliente recebia "seu agendamento está confirmado" de um agendamento cancelado.
--  5. Agendamento sem compromisso na Agenda (o antigo diálogo do Kanban, sem serviço) só
--     casa com a automação de "todos os serviços".
--
-- A assinatura de `fn_due_appointment_reminders` NÃO muda: o despachante a chama igual.

alter table public.whatsapp_template_automations
  add column if not exists event_type_id uuid
  references public.calendar_event_types (id) on delete restrict;

-- Auto-curativo ANTES da trava (doutrina de migrations): um clone com duas automações
-- ativas do mesmo gatilho e serviço manteria a mais antiga e pausaria as outras — que já
-- mandavam mensagem em dobro. Produção medida antes de escrever: nenhuma duplicata.
with classificadas as (
  select id,
         row_number() over (
           partition by organization_id, trigger_kind,
                        coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
           order by created_at asc, id asc
         ) as posicao
    from public.whatsapp_template_automations
   where status = 'active'
)
update public.whatsapp_template_automations a
   set status = 'paused'
  from classificadas c
 where a.id = c.id and c.posicao > 1;

create unique index if not exists uniq_automacao_ativa_por_servico
  on public.whatsapp_template_automations (
    organization_id, trigger_kind,
    coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

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
    select a.event_type_id
      from public.whatsapp_template_automations a
     where a.id = p_automation_id and a.organization_id = p_organization_id
  ),
  ultima_por_lead as (
    select distinct on (a.lead_id)
      a.lead_id,
      a.contact_id,
      a.id as activity_id,
      a.type,
      a.source_module,
      a.source_id,
      (a.payload->>'scheduled_at')::timestamptz as scheduled_at
    from public.crm_lead_activities a
    where a.organization_id = p_organization_id
      and a.type in ('meeting_scheduled', 'meeting_outcome')
    order by a.lead_id, a.performed_at desc
  ),
  do_dia as (
    -- O compromisso da Agenda, quando a atividade veio dela: é dele que sai o SERVIÇO e se
    -- foi cancelado. Atividade do antigo diálogo do Kanban não tem compromisso (LEFT JOIN).
    select u.*, c.event_type_id as servico_do_agendamento, c.status as status_na_agenda
      from ultima_por_lead u
      left join public.calendar_appointments c
        on u.source_module = 'agenda.agendamentos'
       and c.id::text = u.source_id::text
       and c.organization_id = p_organization_id
     where u.type = 'meeting_scheduled'
       and (u.scheduled_at at time zone 'America/Sao_Paulo')::date
         = (p_now at time zone 'America/Sao_Paulo')::date
  )
  select
    d.lead_id,
    d.contact_id,
    d.activity_id,
    d.scheduled_at,
    coalesce(c.display_name, c.name, c.phone_number, 'Sem nome') as display_name
  from do_dia d
  join public.contacts c on c.id = d.contact_id
  where exists (select 1 from minha)
    -- cancelado na Agenda não recebe lembrete
    and d.status_na_agenda is distinct from 'cancelled'
    and (
      -- automação de UM serviço: só agendamentos desse serviço
      (
        (select m.event_type_id from minha m) is not null
        and d.servico_do_agendamento = (select m.event_type_id from minha m)
      )
      or
      -- automação de TODOS os serviços: tudo, menos o serviço que tem automação própria
      -- ativa (o específico vence — senão o cliente receberia as duas mensagens)
      (
        (select m.event_type_id from minha m) is null
        and not exists (
          select 1 from public.whatsapp_template_automations o
           where o.organization_id = p_organization_id
             and o.trigger_kind = 'appointment_reminder'
             and o.status = 'active'
             and o.event_type_id is not null
             and o.event_type_id = d.servico_do_agendamento
        )
      )
    )
    and not exists (
      select 1 from public.whatsapp_template_automation_sends s
      where s.automation_id = p_automation_id
        and s.occurrence_key = d.activity_id::text
    );
$$;

revoke all on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) to service_role;

-- A listagem de automações embute o serviço (relacionamento novo): recarrega o esquema.
notify pgrst, 'reload schema';
