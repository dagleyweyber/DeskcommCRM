-- ============================================================================
-- 0182 — AGENDA, NÚCLEO (Fase 1, sem Google Calendar)
--
-- Adaptada do módulo "Agenda" do upstream (melgarafael/DeskcommCRM) — mas
-- não é cópia: o upstream espalha este schema em ~25 migrations entrelaçadas
-- com sincronização Google Calendar/Meet e um ciclo de confirmação/no-show
-- que dependem de colunas que só fazem sentido com Google conectado. Esta
-- migration traz só o que um compromisso precisa pra existir e ser
-- marcado/remarcado/cancelado por um humano ou pelo agente de IA — a decisão
-- completa está no plano desta sessão (DIRC: calcular quando precisar).
--
-- Escopo cortado nesta primeira fatia (fica para depois, nenhum bloqueia o
-- essencial): "cliente pela agenda" (convive, quando entrar, com nosso
-- `became_customer_at`/`existing_customer` já existente — migration 0164);
-- toggle "colegas podem mexer na agenda" (default hoje: `agent` só mexe na
-- própria agenda, `manager`+ mexe em qualquer uma — comportamento fixo, sem
-- toggle); `calendar_locations`; os crons de confirmação/recuperação de
-- no-show. A concorrência otimista (campo `revision`) NÃO virou uma stored
-- procedure como no upstream — é um `update ... where revision = $1`
-- resolvido em TypeScript, mesmo padrão de trava otimista que
-- `lib/leads/stage-operations.ts` já usa neste repo (achado por
-- `pg-como-supabase.ts`: "o repo usa update().eq(id).eq(campo).select(id) +
-- if (linhas.length === 0) como TRAVA otimista"). Menos uma função SQL pra
-- manter sincronizada com o TypeScript que já faz a mesma pergunta.
--
-- ─── Por que `calendar_appointments.contact_id` é obrigatório, não `lead_id`
--
-- Quem agenda é sempre uma PESSOA (contato) — o vínculo com o negócio em
-- aberto é polimórfico via `crm_lead_links` (coluna `target_kind='appointment'`
-- já presente no CHECK desde a migration original desta tabela), igual a
-- mensagem e conversa. Um compromisso pode nascer sem lead nenhum em aberto
-- (ex.: cliente antigo remarcando) — forçar `lead_id` obrigaria a inventar um
-- negócio que não existe.
--
-- ─── Por que a disponibilidade não ganha tabela própria de "jornada"
--
-- `attendant_availability.schedule` (migration 0039, spec 13) já guarda um
-- jsonb de horário por pessoa — é exatamente o que `calendar_availability_exceptions`
-- precisa sobrepor (um dia específico que foge da regra semanal). Duplicar
-- em tabela nova seria o anti-pattern nº 2 do CLAUDE.md (duplicação sem
-- source of truth declarado).
--
-- ─── RLS por-comando, não `for all`
--
-- Mesmo raciocínio de `crm_tasks` (migration 0179): uma policy única
-- deixaria `viewer` apagar compromisso de qualquer um pelo PostgREST. Leitura
-- é da organização inteira (a grade precisa mostrar todo mundo pra montar a
-- visão semanal); escrita em `calendar_appointments` é do PRÓPRIO dono
-- (`owner_user_id = auth.uid()`) ou de `manager`+ — sem o toggle de colegas
-- desta fase, não há meio-termo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. calendar_event_types — o "molde" do compromisso (nome, duração, buffers)
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_event_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  slug text not null,

  duration_minutes integer not null default 30 check (duration_minutes > 0),
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes >= 0),
  buffer_after_minutes integer not null default 0 check (buffer_after_minutes >= 0),

  -- "Com quanto tempo de antecedência dá pra marcar" e "até quando no
  -- futuro a grade publica horário" — sem isso a IA ofereceria horário daqui
  -- a 2 minutos ou daqui a 3 anos.
  minimum_notice_minutes integer not null default 60 check (minimum_notice_minutes >= 0),
  booking_window_days integer not null default 30 check (booking_window_days > 0),

  -- Nulo = usa o padrão de `duration_minutes` como passo da grade. Existe
  -- separado porque um tipo de 50min pode querer slots de 15 em 15 (exames
  -- com horário fixo, mas encaixe mais fino).
  slot_interval_minutes integer check (slot_interval_minutes is null or slot_interval_minutes > 0),

  location_kind text not null default 'in_person'
    check (location_kind in ('in_person', 'phone', 'video', 'other')),
  location_detail text,

  default_owner_user_id uuid references auth.users(id) on delete set null,

  is_active boolean not null default true,
  position numeric not null default 1000,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, slug)
);

create index if not exists calendar_event_types_org_ativos_idx
  on public.calendar_event_types (organization_id)
  where is_active;

alter table public.calendar_event_types enable row level security;

drop policy if exists calendar_event_types_select on public.calendar_event_types;
create policy calendar_event_types_select on public.calendar_event_types
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists calendar_event_types_write on public.calendar_event_types;
create policy calendar_event_types_write on public.calendar_event_types
  using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.calendar_event_types from anon;
grant select, insert, update, delete on public.calendar_event_types to authenticated;
grant all on public.calendar_event_types to service_role;

drop trigger if exists trg_calendar_event_types_updated_at on public.calendar_event_types;
create trigger trg_calendar_event_types_updated_at
  before update on public.calendar_event_types
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. calendar_appointments — o compromisso marcado
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  event_type_id uuid references public.calendar_event_types(id) on delete set null,

  title text not null,
  description text,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null default 'America/Sao_Paulo',

  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),

  owner_user_id uuid references auth.users(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,

  location_kind text not null default 'in_person'
    check (location_kind in ('in_person', 'phone', 'video', 'other')),
  location_detail text,

  notes text,

  cancelled_at timestamptz,
  cancellation_reason text,

  -- Auto-FK: a nova marcação criada por um "remarcar" aponta pra qual
  -- compromisso ela substituiu — histórico sem duplicar linha.
  rescheduled_from_id uuid references public.calendar_appointments(id) on delete set null,

  created_by_kind text not null default 'user' check (created_by_kind in ('user', 'ai_agent')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_agent_id uuid,
  source text not null default 'manual',

  -- Concorrência otimista resolvida em TypeScript (ver cabeçalho) — incrementa
  -- a cada UPDATE bem-sucedido.
  revision integer not null default 1,

  reminder_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_appointments_periodo_valido check (ends_at > starts_at),
  constraint calendar_appointments_cancelamento_consistente check (
    (status = 'cancelled' and cancelled_at is not null and cancellation_reason is not null)
    or (status <> 'cancelled' and cancelled_at is null)
  )
);

-- A consulta mais comum: "o que tem marcado nesta organização, neste
-- período" — a grade inteira parte daqui.
create index if not exists calendar_appointments_org_periodo_idx
  on public.calendar_appointments (organization_id, starts_at);

-- "O que ESTE contato tem marcado" — painel do contato/lead.
create index if not exists calendar_appointments_contato_idx
  on public.calendar_appointments (contact_id);

-- O cálculo de disponibilidade filtra por dono e exclui cancelado/no-show —
-- parcial porque a maioria das consultas quer só o que ainda ocupa a agenda.
create index if not exists calendar_appointments_org_vivos_idx
  on public.calendar_appointments (organization_id, owner_user_id, starts_at)
  where status not in ('cancelled', 'no_show');

alter table public.calendar_appointments enable row level security;

drop policy if exists calendar_appointments_select on public.calendar_appointments;
create policy calendar_appointments_select on public.calendar_appointments
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

-- Sem o toggle "colegas" desta fase: `agent` mexe só na própria agenda
-- (`owner_user_id = auth.uid()`); `manager`+ mexe em qualquer uma da
-- organização. `auth.uid() is null` cobre o service role (worker/cron) —
-- mesma regra que `crm_tasks`/`attendant_availability` já usam para o
-- caminho de processo interno.
drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin()
    or auth.uid() is null
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent')
        and (owner_user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  )
  with check (
    public.fn_is_platform_admin()
    or auth.uid() is null
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent')
        and (owner_user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

revoke all on public.calendar_appointments from anon;
grant select, insert, update, delete on public.calendar_appointments to authenticated;
grant all on public.calendar_appointments to service_role;

drop trigger if exists trg_calendar_appointments_updated_at on public.calendar_appointments;
create trigger trg_calendar_appointments_updated_at
  before update on public.calendar_appointments
  for each row execute function public.fn_set_updated_at();

-- Realtime — mesma doutrina de `messages`/`conversations`: a grade precisa
-- ver uma marcação feita por outra aba/pessoa sem polling.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'calendar_appointments'
  ) then
    alter publication supabase_realtime add table public.calendar_appointments;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. calendar_availability_exceptions — exceção pontual por pessoa/data
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  date date not null,
  -- 'unavailable' = bloqueia o dia/trecho inteiro (feriado, folga); 'available'
  -- = ABRE um horário que a jornada semanal não previa (plantão extra). Nulos
  -- em start/end = o dia inteiro.
  kind text not null check (kind in ('unavailable', 'available')),
  start_time time,
  end_time time,
  reason text,

  created_at timestamptz not null default now(),

  constraint calendar_exceptions_horario_consistente check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and end_time > start_time)
  )
);

create index if not exists calendar_exceptions_org_dia_idx
  on public.calendar_availability_exceptions (organization_id, user_id, date);

alter table public.calendar_availability_exceptions enable row level security;

drop policy if exists calendar_availability_exceptions_select on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_select on public.calendar_availability_exceptions
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

-- Escrita: a própria pessoa ou manager+ — mesmo par de `attendant_availability`.
drop policy if exists calendar_availability_exceptions_write on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_write on public.calendar_availability_exceptions
  using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  )
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

revoke all on public.calendar_availability_exceptions from anon;
grant select, insert, update, delete on public.calendar_availability_exceptions to authenticated;
grant all on public.calendar_availability_exceptions to service_role;

-- ---------------------------------------------------------------------------
-- 4. user_organizations.calendar_color — a cor da pessoa na grade
-- ---------------------------------------------------------------------------
alter table public.user_organizations
  add column if not exists calendar_color text;

comment on column public.user_organizations.calendar_color is
  'Cor da pessoa na grade da Agenda (paleta fixa de 8, ver components/agenda/paleta.ts). Nula = derivada por hash do user_id no cliente, nunca da posição na lista — pra não mudar quando alguém entra/sai da equipe.';

-- ---------------------------------------------------------------------------
-- 5. fn_limpar_vinculos_do_agendamento — limpa crm_lead_links ao apagar
-- ---------------------------------------------------------------------------
-- `crm_lead_links.target_kind='appointment'` já é vocabulário válido (CHECK
-- original da tabela, sem migration nova aqui). Apagar o compromisso sem
-- isto deixaria um vínculo órfão apontando pra um `target_id` inexistente.
create or replace function public.fn_limpar_vinculos_do_agendamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.crm_lead_links
   where target_kind = 'appointment'
     and target_id = old.id;
  return old;
end;
$$;

revoke execute on function public.fn_limpar_vinculos_do_agendamento() from public, anon, authenticated;
grant  execute on function public.fn_limpar_vinculos_do_agendamento() to service_role;

drop trigger if exists trg_limpar_vinculos_do_agendamento on public.calendar_appointments;
create trigger trg_limpar_vinculos_do_agendamento
  after delete on public.calendar_appointments
  for each row execute function public.fn_limpar_vinculos_do_agendamento();

-- ---------------------------------------------------------------------------
-- 6. LGPD — a anonimização do contato alcança os compromissos dele
-- ---------------------------------------------------------------------------
-- Mesmo padrão de `trg_redigir_tarefas_ao_anonimizar` (migration 0179):
-- gancho na transição `is_anonymized false → true`, preserva horário/status
-- (registro de operação), redige texto livre (dado pessoal).
create or replace function public.fn_redigir_agenda_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.calendar_appointments
     set title       = 'Compromisso anonimizado',
         description = null,
         notes       = null,
         location_detail = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_agenda_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_agenda_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_agenda_ao_anonimizar on public.contacts;
create trigger trg_redigir_agenda_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_agenda_do_contato_anonimizado();

comment on table public.calendar_event_types is
  'O "molde" de um tipo de compromisso (duração, buffers, janela de agendamento). Núcleo da Agenda (Fase 1, sem Google Calendar).';
comment on table public.calendar_appointments is
  'Compromisso marcado com um contato. Vínculo com negócio em aberto é polimórfico via crm_lead_links (target_kind=''appointment''), nunca lead_id direto — um compromisso pode existir sem negócio aberto.';
comment on column public.calendar_appointments.revision is
  'Concorrência otimista resolvida em TypeScript (update ... where revision = $1), não stored procedure — mesmo padrão de trava otimista já usado em lib/leads/stage-operations.ts.';
comment on table public.calendar_availability_exceptions is
  'Exceção pontual (feriado, plantão extra) por cima de attendant_availability.schedule — não duplica a jornada semanal, só sobrepõe um dia.';
