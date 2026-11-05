-- ============================================================================
-- 0211 — UM AVISO POR PACIENTE E DIA
--
-- Pedido do dono do produto (2026-11-04), B'Laser Parnamirim: o Belle sobe o
-- pacote do paciente como 2, 3 (até 7) agendamentos no MESMO dia, e a
-- automação mandava uma confirmação por agendamento — cada uma com um horário
-- diferente, o que confundia o paciente. Medido (últimos 30 dias): 535 de
-- 1.768 dias de paciente (30%) têm mais de um agendamento; 98% deles cabem
-- numa janela de 2h, ou seja, é UMA ida à clínica com vários procedimentos em
-- sequência. A regra do Belle não tem como mudar; do nosso lado:
--
--  1. A unidade de envio passa a ser o GRUPO (paciente + dia + automação). O
--     "líder" do grupo é o agendamento mais cedo do dia, e só ele gera mensagem
--     — com o horário de CHEGADA (decisão do dono: opção C). Os demais ficam
--     calados.
--  2. Quem é o grupo é decidido por UMA função (`fn_grupo_do_agendamento`),
--     usada pelo lembrete (aqui) e pela resposta do botão (TypeScript): "Confirmar"
--     confirma o grupo inteiro e "Preciso remarcar" desmarca o grupo inteiro,
--     com UM aviso na Central. Duas cópias da regra divergiriam.
--  3. A chave de "já enviei" continua sendo o id do líder. Isso dá, sem coluna
--     nova, a regra pedida: se o líder muda (remarcou para outro horário, o
--     líder foi cancelado e outro assumiu, entrou um encaixe MAIS CEDO), o
--     horário de chegada que o paciente conhece mudou e ele recebe a mensagem
--     atualizada; se só entrou um procedimento depois da chegada, o que o
--     paciente vê não mudou e não há mensagem repetida.
--  4. Serviços misturados (Laser + Facial, 24% dos casos) continuam gerando uma
--     mensagem por automação — cada serviço usa o seu modelo (decisão do dono).
--     O grupo é por escopo da automação, não por paciente.
--
-- Compatibilidade no deploy: `fn_due_appointment_reminders` mantém a assinatura
-- e as colunas de saída da 0201. A imagem antiga do app, que a chama igual,
-- passa a mandar só o líder — o comportamento certo — e a nova faz o resto.
--
-- Histórico: os envios já feitos usaram o id de CADA agendamento como chave.
-- O id do líder já está entre eles, então ninguém recebe de novo na virada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. fn_grupo_do_agendamento — quem faz parte do mesmo aviso
-- ---------------------------------------------------------------------------
-- Todos os agendamentos NÃO cancelados do mesmo paciente, no mesmo dia (no fuso
-- da clínica), dentro do escopo da automação. Devolve também o que já passou
-- (compareceu/faltou): o líder é o primeiro do dia mesmo que ele já tenha
-- acontecido — senão o segundo procedimento viraria "líder" e o paciente
-- receberia o aviso da manhã no meio da visita.
create or replace function public.fn_grupo_do_agendamento(
  p_organization_id uuid,
  p_automation_id uuid,
  p_appointment_id uuid
)
returns table (
  id uuid,
  starts_at timestamptz,
  status text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with minha as (
    select a.event_type_id,
           a.timing_kind,
           coalesce(a.timing_value, 0) as timing_value
      from public.whatsapp_template_automations a
     where a.id = p_automation_id and a.organization_id = p_organization_id
  ),
  fuso as (
    select coalesce(
      (select s.default_schedule->>'timezone' from public.calendar_settings s where s.organization_id = p_organization_id),
      'America/Sao_Paulo'
    ) as tz
  ),
  base as (
    select c.contact_id, (c.starts_at at time zone f.tz)::date as dia
      from public.calendar_appointments c
      cross join fuso f
     where c.organization_id = p_organization_id and c.id = p_appointment_id
  )
  select c.id, c.starts_at, c.status
    from public.calendar_appointments c
    cross join fuso f
    cross join base b
    cross join minha m
   where c.organization_id = p_organization_id
     and c.contact_id = b.contact_id
     and (c.starts_at at time zone f.tz)::date = b.dia
     and c.status <> 'cancelled'
     and (
       -- automação de UM serviço: só os desse serviço
       (m.event_type_id is not null and c.event_type_id = m.event_type_id)
       or
       -- automação de TODOS os serviços: tudo, menos o serviço que tem automação
       -- própria ativa no MESMO momento (o específico vence)
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
   order by c.starts_at, c.id;
$$;

revoke all on function public.fn_grupo_do_agendamento(uuid, uuid, uuid) from public;
revoke execute on function public.fn_grupo_do_agendamento(uuid, uuid, uuid) from anon, authenticated;
grant execute on function public.fn_grupo_do_agendamento(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. fn_due_appointment_reminders — só o líder de cada grupo
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

notify pgrst, 'reload schema';
