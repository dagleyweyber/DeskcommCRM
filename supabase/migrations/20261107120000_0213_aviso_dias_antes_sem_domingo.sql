-- 0213 — aviso "X dias antes" nunca sai no domingo: vai para o sábado
--
-- B'Laser Parnamirim, 2026-11-07: a confirmação "1 dia antes às 8h" de um
-- agendamento de segunda saía no DOMINGO às 8h (o cálculo só subtraía dias do
-- calendário). A clínica quer a agenda de segunda confirmada no sábado.
--
-- Regra: em `days_before`, se o dia do aviso cair num domingo, o aviso vai para o
-- sábado às 8h. Vale para qualquer X (terça com "2 dias antes" também cai no
-- domingo -> sábado). `hours_before` e `day_of_8am` não mudam. Só o cálculo de
-- `enviar_em` muda; assinatura, colunas e o resto da consulta são os da 0212.

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
  janela as (
    -- Os agendamentos NÃO cancelados do escopo desta automação, a partir de 1 dia
    -- atrás (para enxergar o irmão que já começou) até o maior "antes" (7 dias).
    select c.id, c.contact_id, c.starts_at, c.event_type_id, c.status,
           (c.starts_at at time zone f.tz)::date as dia
      from public.calendar_appointments c
      cross join fuso f
      cross join minha m
     where c.organization_id = p_organization_id
       and c.status <> 'cancelled'
       and c.starts_at > p_now - interval '1 day'
       and c.starts_at <= p_now + interval '8 days'
       and (
         (m.event_type_id is not null and c.event_type_id = m.event_type_id)
         or
         (
           m.event_type_id is null
           and not exists (
             select 1 from public.whatsapp_template_automations o
              where o.organization_id = p_organization_id
                and o.trigger_kind = 'appointment_reminder'
                and o.status = 'active'
                and o.event_type_id is not null
                and o.event_type_id = c.event_type_id
                and o.timing_kind = m.timing_kind
                and coalesce(o.timing_value, 0) = m.timing_value
           )
         )
       )
  ),
  lideres as (
    -- O líder é o primeiro do dia do paciente. Os outros nunca geram mensagem.
    select j.*,
           row_number() over (partition by j.contact_id, j.dia order by j.starts_at, j.id) as posicao
      from janela j
  ),
  candidatos as (
    select l.id, l.contact_id, l.starts_at
      from lideres l
      cross join minha m
     where l.posicao = 1
       and l.starts_at > p_now
       and l.status in ('pending', 'confirmed')
       -- confirmação só faz sentido para quem ainda não confirmou
       and (not m.pede_confirmacao or l.status = 'pending')
  ),
  devidos as (
    select k.*,
           case m.timing_kind
             when 'hours_before' then k.starts_at - make_interval(hours => m.timing_value)
             when 'days_before' then
               -- Nunca no domingo: se o dia do aviso cair num domingo, vai para o sábado
               -- (agenda de segunda confirmada no sábado). Domingo = dow 0.
               (((k.starts_at at time zone f.tz)::date - m.timing_value
                 - case when extract(dow from ((k.starts_at at time zone f.tz)::date - m.timing_value)) = 0
                        then 1 else 0 end)
                 + time '08:00') at time zone f.tz
             else
               ((k.starts_at at time zone f.tz)::date + time '08:00') at time zone f.tz
           end as enviar_em
      from candidatos k
      cross join minha m
      cross join fuso f
  ),
  chaves_enviadas as (
    -- Tudo o que esta automação já mandou (chave nova: id do compromisso).
    select s.occurrence_key as chave
      from public.whatsapp_template_automation_sends s
     where s.automation_id = p_automation_id
  ),
  chaves_antigas as (
    -- Chave antiga (0169/0199): o envio gravou o id da atividade `meeting_scheduled`;
    -- o compromisso correspondente é `source_id`. Calculado uma vez, só para os
    -- envios que existem — não uma vez por candidato.
    select act.source_id::text as chave
      from public.crm_lead_activities act
      join chaves_enviadas e on e.chave = act.id::text
     where act.organization_id = p_organization_id
       and act.source_module = 'agenda.agendamentos'
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
    and not exists (select 1 from chaves_enviadas e where e.chave = d.id::text)
    and not exists (select 1 from chaves_antigas a where a.chave = d.id::text);
$$;

revoke all on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
