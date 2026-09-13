-- 0169_automacoes_de_template — 1ª automação recorrente por gatilho de
-- DADO do lead (não por evento único): lembrete de agendamento.
--
-- Diferente de Campanhas (0167), que dispara UMA VEZ pra um público
-- materializado, isto roda PRA SEMPRE: todo dia, todo lead que tenha um
-- agendamento marcado pra hoje recebe um lembrete, sem intervenção humana
-- depois da configuração inicial. `trigger_kind` é vocabulário aberto —
-- a próxima automação anunciada (aniversariantes) entra só registrando um
-- resolver novo em `lib/automations/triggers/`, sem migration nova.
--
-- Agendamento não é coluna, é evento: `crm_lead_activities` é append-only
-- (nenhum `.update()` em todo o `lib/`), e `scheduled_at` mora dentro de
-- `payload` (jsonb) da linha `type='meeting_scheduled'` mais recente do
-- lead. Reagendar é emitir uma linha NOVA — por isso o dedup de envio usa
-- o `activity_id` como chave de ocorrência: reagendou, `activity_id`
-- novo, o dedup não acha nada, manda de novo. Rastrear por DATA exigiria
-- comparar timestamp a cada tick; rastrear por `activity_id` é o próprio
-- evento dizendo "esta é uma ocorrência diferente".
create table if not exists public.whatsapp_template_automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  trigger_kind text not null,
  channel_session_id uuid not null references public.channel_sessions(id),
  template_name text not null,
  template_language text not null,
  -- Mesmo formato de `whatsapp_campaigns.variable_mapping`
  -- (`lib/messaging/variable-mapping.ts`) — `{[slotKey]: {kind:'fixed',
  -- value} | {kind:'contact_name'|'contact_first_name'|'appointment_date'
  -- |'appointment_time'}}`. Diferente de Campanhas, aqui não existe
  -- destinatário fixo pra pré-resolver: o valor é calculado NA HORA do
  -- envio, porque a automação roda sobre quem quer que apareça amanhã.
  variable_mapping jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_template_automations_status_check
    check (status in ('draft', 'active', 'paused'))
);

create or replace trigger trg_whatsapp_template_automations_updated_at
  before update on public.whatsapp_template_automations
  for each row execute function public.fn_set_updated_at();

-- É o que o despachante varre a cada tick: "as automações ativas de toda
-- a plataforma" (mesmo padrão de `whatsapp_campaigns_org_status_idx`).
create index if not exists whatsapp_template_automations_org_status_idx
  on public.whatsapp_template_automations (organization_id, status);

alter table public.whatsapp_template_automations enable row level security;

drop policy if exists whatsapp_template_automations_select on public.whatsapp_template_automations;
drop policy if exists whatsapp_template_automations_write on public.whatsapp_template_automations;

create policy whatsapp_template_automations_select
  on public.whatsapp_template_automations for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Piso `manager`: disparo automático em massa é ação de gestor, mesmo
-- piso de `whatsapp_campaigns_write` (0167).
create policy whatsapp_template_automations_write
  on public.whatsapp_template_automations
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on public.whatsapp_template_automations from anon;

-- A trava de "já mandei pra esta ocorrência" — mesmo papel de
-- `uq_crm_lead_reactivations_uma_viva`, adaptado pra dedup por ocorrência
-- em vez de "no máximo um pendente por lead".
create table if not exists public.whatsapp_template_automation_sends (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.whatsapp_template_automations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.crm_leads(id),
  contact_id uuid not null references public.contacts(id),
  -- Pro gatilho de agendamento: o `id` da linha `meeting_scheduled` em
  -- `crm_lead_activities`. Genérico (`text`, não `uuid`) de propósito — a
  -- próxima automação (aniversariantes) não tem uma linha de atividade pra
  -- apontar; a chave dela vai ser outra forma (ex.: `contact_id || ano`).
  occurrence_key text not null,
  external_id text,
  status text not null default 'sent',
  error_message text,
  sent_at timestamptz not null default now(),
  constraint whatsapp_template_automation_sends_status_check
    check (status in ('sent', 'failed'))
);

create unique index if not exists whatsapp_template_automation_sends_occurrence_uidx
  on public.whatsapp_template_automation_sends (automation_id, occurrence_key);

alter table public.whatsapp_template_automation_sends enable row level security;

drop policy if exists whatsapp_template_automation_sends_select on public.whatsapp_template_automation_sends;
drop policy if exists whatsapp_template_automation_sends_write on public.whatsapp_template_automation_sends;

create policy whatsapp_template_automation_sends_select
  on public.whatsapp_template_automation_sends for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy whatsapp_template_automation_sends_write
  on public.whatsapp_template_automation_sends
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on public.whatsapp_template_automation_sends from anon;

-- Um índice funcional pra "data do agendamento" foi tentado aqui e
-- recusado pelo Postgres: `(payload->>'scheduled_at')::date` não é
-- IMMUTABLE quando o texto carrega hora e fuso (a data resultante depende
-- do fuso de sessão pra resolver) — o mesmo motivo pelo qual a FUNÇÃO
-- abaixo usa `at time zone 'America/Sao_Paulo'` em vez de `::date` cru, e
-- exatamente por isso não dá pra indexar direto. Sem um índice dedicado,
-- a travessia por `(organization_id, type, performed_at desc)` do
-- `DISTINCT ON` abaixo já é coberta por `idx_crm_lead_activities_org_meeting`
-- (a partial index da Fase 3 do dashboard, mesmo par de tipos) — o filtro
-- de data roda DEPOIS da deduplicação por lead, sobre um conjunto já
-- pequeno; escala além disso é problema pra quando aparecer, não pra
-- resolver com um índice frágil agora.
--
-- "Quem tem agendamento HOJE (fuso de São Paulo — mesma premissa fixa de
-- `lib/automation/throttle.ts`, nenhuma instalação multi-fuso ainda) e
-- ainda não recebeu lembrete desta automação."
--
-- DISTINCT ON substitui `proximasReunioesPorLead`
-- (`lib/leads/next-meeting.ts`) em SQL: o evento mais recente entre
-- `meeting_scheduled`/`meeting_outcome` de cada lead responde "está
-- pendente?" — se for `meeting_outcome`, o agendamento mais novo já foi
-- resolvido, e o lead não aparece.
-- `p_now` é injetável (default `now()`) — não é enfeite de teste: sem ele,
-- "hoje" seria sempre o relógio real do banco, e nenhum teste de invariante
-- conseguiria fixar um dia determinístico (mesmo problema que
-- `dispatchCampaignsTick`/`dispatchAutomationsTick` já resolvem do lado
-- JS com `deps.now`). Em produção, o resolver chama sem este parâmetro —
-- o default cobre o caminho real.
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
  with ultima_por_lead as (
    select distinct on (a.lead_id)
      a.lead_id,
      a.contact_id,
      a.id as activity_id,
      a.type,
      (a.payload->>'scheduled_at')::timestamptz as scheduled_at
    from public.crm_lead_activities a
    where a.organization_id = p_organization_id
      and a.type in ('meeting_scheduled', 'meeting_outcome')
    order by a.lead_id, a.performed_at desc
  )
  select
    u.lead_id,
    u.contact_id,
    u.activity_id,
    u.scheduled_at,
    coalesce(c.display_name, c.name, c.phone_number, 'Sem nome') as display_name
  from ultima_por_lead u
  join public.contacts c on c.id = u.contact_id
  where u.type = 'meeting_scheduled'
    and (u.scheduled_at at time zone 'America/Sao_Paulo')::date
      = (p_now at time zone 'America/Sao_Paulo')::date
    and not exists (
      select 1 from public.whatsapp_template_automation_sends s
      where s.automation_id = p_automation_id
        and s.occurrence_key = u.activity_id::text
    );
$$;

revoke all on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) from anon;
grant execute on function public.fn_due_appointment_reminders(uuid, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
