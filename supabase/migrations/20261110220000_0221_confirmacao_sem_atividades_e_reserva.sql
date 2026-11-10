-- 0221 — confirmação de agendamento: dedup só pelo envio, e reserva antes de enviar
--
-- B'Laser Parnamirim, 2026-11-10 — segunda vez que a confirmação de Laser parou
-- (0212 em 06/11, 0219 hoje). As duas correções anteriores trataram o SINTOMA (o
-- plano da consulta); esta tira a CAUSA e prepara o despachante para rodar a cada
-- minuto.
--
-- 1. A causa da lentidão era `fn_due_appointment_reminders` ler
--    `crm_lead_activities` (62 mil linhas, crescendo) para reconhecer os envios
--    gravados com a chave ANTIGA (id da atividade, antes da 0201). Restavam 64
--    desses envios, todos de outubro. Aqui eles ganham o `appointment_id` de uma
--    vez (`fn_vincular_envios_antigos_ao_compromisso`), e a função passa a olhar
--    SÓ `whatsapp_template_automation_sends`, por dois índices:
--      - (automation_id, occurrence_key) — o único que já existia;
--      - (automation_id, appointment_id) — novo, abaixo.
--    O custo da consulta deixa de depender do tamanho da timeline do CRM.
--
-- 2. `status` ganha 'sending' — a RESERVA. O despachante grava a linha ANTES de
--    chamar a Meta; a chave única (automation_id, occurrence_key) faz de dois ticks
--    simultâneos um só envio (o segundo recebe 23505 e pula). É o que permite o
--    cron passar de 15 em 15 min para 1 em 1 min sem mensagem em dobro: com 15 min
--    e ~10 envios por tick, 80 pacientes levavam 10 horas para receber.
--    'sending' bloqueia a ocorrência na função (como 'sent'/'failed'/'skipped'):
--    reserva interrompida no meio NÃO é reenviada — envio em dobro é pior que
--    não-envio (mesma regra do `recover-stuck-messages`); o despachante a fecha
--    como 'failed' depois de 10 min.
--
-- Assinatura e colunas da função: inalteradas. Regras de horário (0213): iguais.

-- ---- 1. vocabulário de status ----
alter table public.whatsapp_template_automation_sends
  drop constraint if exists whatsapp_template_automation_sends_status_check;
alter table public.whatsapp_template_automation_sends
  add constraint whatsapp_template_automation_sends_status_check
  check (status in ('sending', 'sent', 'failed', 'skipped'));

-- ---- 2. índice da dedup pelo compromisso ----
create index if not exists whatsapp_template_automation_sends_compromisso_idx
  on public.whatsapp_template_automation_sends (automation_id, appointment_id)
  where appointment_id is not null;

-- ---- 3. envios antigos ganham o compromisso ----
-- Idempotente: só toca linha com `appointment_id` nulo. Serve a qualquer clone
-- (nenhum id fixo). Duas origens de chave sem compromisso:
--   a) chave antiga = id da atividade `meeting_scheduled` → compromisso = source_id;
--   b) chave nova gravada antes de a coluna existir → a própria chave é o compromisso.
create or replace function public.fn_vincular_envios_antigos_ao_compromisso()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_a integer;
  v_b integer;
begin
  update public.whatsapp_template_automation_sends s
     set appointment_id = act.source_id
    from public.crm_lead_activities act
   where s.appointment_id is null
     and s.occurrence_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and act.id = s.occurrence_key::uuid
     and act.organization_id = s.organization_id
     and act.source_module = 'agenda.agendamentos'
     and act.source_id is not null
     and exists (select 1 from public.calendar_appointments c where c.id = act.source_id);
  get diagnostics v_a = row_count;

  update public.whatsapp_template_automation_sends s
     set appointment_id = c.id
    from public.calendar_appointments c
   where s.appointment_id is null
     and s.occurrence_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and c.id = s.occurrence_key::uuid
     and c.organization_id = s.organization_id;
  get diagnostics v_b = row_count;

  return v_a + v_b;
end;
$$;

revoke all on function public.fn_vincular_envios_antigos_ao_compromisso() from public;
revoke execute on function public.fn_vincular_envios_antigos_ao_compromisso() from anon, authenticated;
grant execute on function public.fn_vincular_envios_antigos_ao_compromisso() to service_role;

select public.fn_vincular_envios_antigos_ao_compromisso();

-- ---- 4. a consulta de quem está devido não lê mais a timeline do CRM ----
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

notify pgrst, 'reload schema';
