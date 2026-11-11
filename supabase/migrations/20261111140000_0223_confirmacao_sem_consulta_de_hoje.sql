-- 0223 — confirmação "N dias antes" não sai para consulta de HOJE.
-- Em 2026-11-11 (B'Laser Parnamirim) 5 pacientes receberam a confirmação de uma consulta que
-- era do próprio dia: 3 agendadas minutos antes e 2 remarcadas para hoje. O horário de envio
-- (08:00 do dia anterior) já havia passado, então a regra disparava na hora.
-- Só muda o filtro de candidatos; assinatura, saída e grants são os da 0221.

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
      cross join fuso f
     where l.posicao = 1
       -- "N dias antes" só vale para consulta em dia FUTURO. Agendamento feito (ou remarcado)
       -- para hoje já é conversa direta com a paciente: "confirme sua consulta" não faz sentido
       -- e antes saía na hora, porque o horário de envio (08:00 de ontem) já tinha passado.
       and (m.timing_kind <> 'days_before'
            or (l.starts_at at time zone f.tz)::date > (p_now at time zone f.tz)::date)
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
    -- Qualquer linha desta automação para este compromisso encerra a ocorrência:
    -- 'sending' (reservada), 'sent', 'failed' (não reenvia), 'skipped' (dispensada).
    -- Duas buscas, cada uma no seu índice; nenhuma lê `crm_lead_activities`.
    and not exists (
      select 1 from public.whatsapp_template_automation_sends s
       where s.automation_id = p_automation_id and s.occurrence_key = d.id::text
    )
    and not exists (
      select 1 from public.whatsapp_template_automation_sends s
       where s.automation_id = p_automation_id and s.appointment_id = d.id
    );
$$;

revoke all on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) to service_role;
