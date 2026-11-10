-- 0219 — fn_due_appointment_reminders volta a caber nos 8 s (a 0212 regrediu)
--
-- B'Laser Parnamirim, 2026-11-10: a confirmação de "Depilação a Laser" parou de
-- sair de novo — 54 pacientes de amanhã sem aviso. O log do app mostrava, a cada
-- 15 min, `fn_due_appointment_reminders falhou` com 57014 (statement timeout).
-- Medido: 17 s e 14,5 milhões de páginas lidas por chamada.
--
-- A 0212 tirou a leitura de `crm_lead_activities` de dentro do `not exists` e a
-- pôs numa CTE (`chaves_antigas`) "calculada uma vez". Mas uma CTE citada uma só
-- vez é EMBUTIDA pelo Postgres (12+), e o planejador voltou a reavaliá-la por
-- candidato — com `e.chave = act.id::text`, o cast impede a chave primária e
-- cada reavaliação varre as 62 mil atividades. Com 382 envios, estourou.
--
-- Correção, sem mudar o resultado:
--   1. `chaves_enviadas` e `chaves_antigas` são `as materialized`: calculadas UMA
--      vez por chamada, por contrato, não por escolha do planejador;
--   2. a chave antiga vira uuid ANTES do join (`chave_uuid`), e o join usa a chave
--      primária de `crm_lead_activities`. Chave que não é uuid fica `null` e não
--      casa com nada — igual à comparação por texto, que também não casava.
--
-- Medido em produção antes de aplicar: mesmos 54 devidos nas duas versões (0
-- diferenças nos dois sentidos); 0,12 s e 3,1 mil páginas contra 17 s.
-- Assinatura, colunas, regras de horário (0213) e grants: inalterados.

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
  chaves_enviadas as materialized (
    -- Tudo o que esta automação já mandou (chave nova: id do compromisso). A
    -- versão uuid da chave serve à busca da chave antiga pela chave primária.
    select s.occurrence_key as chave,
           case when s.occurrence_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then s.occurrence_key::uuid end as chave_uuid
      from public.whatsapp_template_automation_sends s
     where s.automation_id = p_automation_id
  ),
  chaves_antigas as materialized (
    -- Chave antiga (0169/0199): o envio gravou o id da atividade `meeting_scheduled`;
    -- o compromisso correspondente é `source_id`. `materialized` + join pela chave
    -- primária: uma busca por envio, uma vez por chamada (ver cabeçalho).
    select act.source_id::text as chave
      from chaves_enviadas e
      join public.crm_lead_activities act on act.id = e.chave_uuid
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
