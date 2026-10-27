-- ============================================================================
-- 0200 — AGENDA POR SALA
--
-- Pedido do dono do produto (2026-10-27, referência visual: agenda do Zandu):
-- a agenda deixa de ser travada por COLABORADOR e passa a ser por SALA
-- ("Sala 1", "Sala 2", "Avaliação"), cada clínica cadastrando as suas. O
-- profissional continua existindo no compromisso, mas OPCIONAL e só
-- informativo — não trava horário (decisão explícita do dono).
--
-- ─── O desenho ───────────────────────────────────────────────────────────────
--  1. `calendar_settings` — UMA linha por organização com o horário de
--     funcionamento PADRÃO da clínica. Tabela própria (e não
--     `organizations.settings`) porque `organizations` só é gravável por admin
--     de plataforma (RLS `orgs_write_platform_admin`), e quem ajusta o horário
--     é o gerente da clínica.
--  2. `calendar_rooms` — as salas. `schedule` NULO = herda o padrão da
--     clínica; preenchido = horário próprio da sala.
--  3. `calendar_event_type_rooms` — em quais salas cada serviço pode ser
--     feito (nenhuma linha = qualquer sala). Tabela de junção com FK, não
--     `uuid[]` (anti-pattern nº 4: FK ausente). É o que impede a IA de marcar
--     depilação na sala de Avaliação ao escolher "qualquer sala livre".
--  4. `calendar_appointments.room_id` — a sala é o recurso que o horário
--     ocupa. Fica NULÁVEL no banco de propósito: a imagem antiga do app ainda
--     roda entre aplicar esta migration e o deploy, e ela não conhece sala —
--     NOT NULL derrubaria todo agendamento nesse intervalo. O app novo sempre
--     grava a sala; compromisso sem sala aparece numa coluna "Sem sala".
--  5. Trava no BANCO contra dois compromissos na mesma sala e horário
--     (constraint de exclusão). Antes só o TypeScript conferia, e duas
--     marcações simultâneas passavam as duas (o próprio handler da 0182 tinha
--     um comentário "não temos constraint de exclusão nesta fase").
--  6. Status `declined` ("Não confirmado") — o cliente respondeu que não vem.
--     Continua OCUPANDO o horário até a recepção remarcar ou cancelar
--     (decisão do dono: um clique errado do cliente não pode perder a vaga).
--  7. Compromisso futuro em `confirmed` volta para `pending`: até hoje o app
--     gravava `confirmed` ao CRIAR (ver comentário em GradeDoDia.tsx) — nenhum
--     cliente confirmou nada. A partir daqui, `confirmed` significa "o cliente
--     confirmou", e é a confirmação automática que vai gravá-lo.
--  8. Exceções de disponibilidade passam a valer por SALA (`room_id`) ou para
--     a CLÍNICA inteira (`user_id` e `room_id` nulos — feriado).
--  9. RLS de escrita em `calendar_appointments`: qualquer `agent`+ da
--     organização. A regra da 0182 ("agent só mexe na própria agenda") supunha
--     agenda por pessoa; com sala, a recepção marca para todas as salas, e o
--     profissional pode nem estar preenchido.
--
-- Backfill genérico (qualquer clone): cada organização que já tem compromisso
-- ganha salas "Sala 1", "Sala 2"… e os compromissos são distribuídos de forma
-- gulosa por ordem de início — um compromisso só entra numa sala onde não
-- colide com outro. Quem tinha dois profissionais atendendo no mesmo horário
-- ganha duas salas; quem nunca teve sobreposição fica com uma só. É o que
-- deixa a constraint de exclusão nascer sem violar dado existente.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. calendar_settings — horário padrão da clínica
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Mesmo formato de `attendant_availability.schedule` (lib/schemas/routing.ts,
  -- `availabilityScheduleSchema`): {timezone, windows:[{dow,start,end}]}.
  default_schedule jsonb not null default
    '{"timezone":"America/Sao_Paulo","windows":[{"dow":1,"start":"08:00","end":"20:00"},{"dow":2,"start":"08:00","end":"20:00"},{"dow":3,"start":"08:00","end":"20:00"},{"dow":4,"start":"08:00","end":"20:00"},{"dow":5,"start":"08:00","end":"20:00"},{"dow":6,"start":"08:00","end":"14:00"}]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.calendar_settings enable row level security;

drop policy if exists calendar_settings_select on public.calendar_settings;
create policy calendar_settings_select on public.calendar_settings
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists calendar_settings_write on public.calendar_settings;
create policy calendar_settings_write on public.calendar_settings
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

revoke all on public.calendar_settings from anon;
grant select, insert, update, delete on public.calendar_settings to authenticated;
grant all on public.calendar_settings to service_role;

drop trigger if exists trg_calendar_settings_updated_at on public.calendar_settings;
create trigger trg_calendar_settings_updated_at
  before update on public.calendar_settings
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. calendar_rooms — as salas da clínica
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_rooms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  color text,
  position numeric not null default 1000,
  -- NULO = herda `calendar_settings.default_schedule`.
  schedule jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists calendar_rooms_nome_ativo_uniq
  on public.calendar_rooms (organization_id, lower(name))
  where is_active;

create index if not exists calendar_rooms_org_idx
  on public.calendar_rooms (organization_id, position);

alter table public.calendar_rooms enable row level security;

drop policy if exists calendar_rooms_select on public.calendar_rooms;
create policy calendar_rooms_select on public.calendar_rooms
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists calendar_rooms_write on public.calendar_rooms;
create policy calendar_rooms_write on public.calendar_rooms
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

revoke all on public.calendar_rooms from anon;
grant select, insert, update, delete on public.calendar_rooms to authenticated;
grant all on public.calendar_rooms to service_role;

drop trigger if exists trg_calendar_rooms_updated_at on public.calendar_rooms;
create trigger trg_calendar_rooms_updated_at
  before update on public.calendar_rooms
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. calendar_event_type_rooms — em quais salas cada serviço pode ser feito
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_event_type_rooms (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null references public.calendar_event_types(id) on delete cascade,
  room_id uuid not null references public.calendar_rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_type_id, room_id)
);

create index if not exists calendar_event_type_rooms_sala_idx
  on public.calendar_event_type_rooms (room_id);

alter table public.calendar_event_type_rooms enable row level security;

drop policy if exists calendar_event_type_rooms_select on public.calendar_event_type_rooms;
create policy calendar_event_type_rooms_select on public.calendar_event_type_rooms
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists calendar_event_type_rooms_write on public.calendar_event_type_rooms;
create policy calendar_event_type_rooms_write on public.calendar_event_type_rooms
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

revoke all on public.calendar_event_type_rooms from anon;
grant select, insert, update, delete on public.calendar_event_type_rooms to authenticated;
grant all on public.calendar_event_type_rooms to service_role;

-- ---------------------------------------------------------------------------
-- 4. Exceções por sala / clínica inteira
-- ---------------------------------------------------------------------------
alter table public.calendar_availability_exceptions
  add column if not exists room_id uuid references public.calendar_rooms(id) on delete cascade;
alter table public.calendar_availability_exceptions
  alter column user_id drop not null;

create index if not exists calendar_exceptions_sala_dia_idx
  on public.calendar_availability_exceptions (organization_id, room_id, date);

comment on column public.calendar_availability_exceptions.room_id is
  'Exceção de UMA sala (manutenção, bloqueio). user_id e room_id nulos = vale para a clínica inteira (feriado).';

-- ---------------------------------------------------------------------------
-- 5. Status `declined` + `pending` volta a significar "aguardando confirmação"
-- ---------------------------------------------------------------------------
alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_status_check;
alter table public.calendar_appointments
  add constraint calendar_appointments_status_check
  check (status in ('pending', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show'));

alter table public.calendar_appointments
  alter column status set default 'pending';

-- Futuro em `confirmed` foi gravado na CRIAÇÃO, não por resposta do cliente
-- (ver cabeçalho, item 7). Idempotente: depois da primeira vez, um
-- `confirmed` futuro só existe porque alguém confirmou — e o critério abaixo
-- não o distingue. Por isso a migration marca o que já converteu.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.calendar_appointments'::regclass
       and attname = 'room_id' and not attisdropped
  ) then
    update public.calendar_appointments
       set status = 'pending'
     where status = 'confirmed'
       and starts_at >= now();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. calendar_appointments.room_id + backfill guloso
-- ---------------------------------------------------------------------------
alter table public.calendar_appointments
  add column if not exists room_id uuid references public.calendar_rooms(id) on delete restrict;

create index if not exists calendar_appointments_sala_vivos_idx
  on public.calendar_appointments (organization_id, room_id, starts_at)
  where status in ('pending', 'confirmed', 'declined', 'completed');

do $$
declare
  r record;
  v_sala uuid;
  v_n integer;
  v_nome text;
begin
  for r in
    select a.id, a.organization_id, a.starts_at, a.ends_at, a.status
      from public.calendar_appointments a
     where a.room_id is null
     order by a.organization_id,
              (a.status in ('pending', 'confirmed', 'declined', 'completed')) desc,
              a.starts_at, a.created_at, a.id
  loop
    v_sala := null;

    if r.status in ('pending', 'confirmed', 'declined', 'completed') then
      select s.id into v_sala
        from public.calendar_rooms s
       where s.organization_id = r.organization_id
         and s.is_active
         and not exists (
           select 1 from public.calendar_appointments o
            where o.room_id = s.id
              and o.id <> r.id
              and o.status in ('pending', 'confirmed', 'declined', 'completed')
              and o.starts_at < r.ends_at
              and r.starts_at < o.ends_at
         )
       order by s.position, s.created_at, s.id
       limit 1;
    else
      -- cancelado/não compareceu não ocupa: qualquer sala serve.
      select s.id into v_sala
        from public.calendar_rooms s
       where s.organization_id = r.organization_id and s.is_active
       order by s.position, s.created_at, s.id
       limit 1;
    end if;

    if v_sala is null then
      select count(*) into v_n from public.calendar_rooms where organization_id = r.organization_id;
      loop
        v_n := v_n + 1;
        v_nome := 'Sala ' || v_n;
        exit when not exists (
          select 1 from public.calendar_rooms
           where organization_id = r.organization_id and is_active and lower(name) = lower(v_nome)
        );
      end loop;
      insert into public.calendar_rooms (organization_id, name, position)
      values (r.organization_id, v_nome, v_n * 1000)
      returning id into v_sala;
    end if;

    update public.calendar_appointments set room_id = v_sala where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Trava no banco: uma sala, um compromisso por vez
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.calendar_appointments'::regclass
       and conname = 'calendar_appointments_sala_sem_sobreposicao'
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_sala_sem_sobreposicao
      exclude using gist (
        room_id with =,
        tstzrange(starts_at, ends_at, '[)') with &&
      ) where (status in ('pending', 'confirmed', 'declined', 'completed'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. RLS de escrita: qualquer agent+ da organização (ver cabeçalho, item 9)
-- ---------------------------------------------------------------------------
drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin()
    or auth.uid() is null
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or auth.uid() is null
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- Realtime da grade: a sala nova precisa aparecer em outra aba sem recarregar.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calendar_rooms'
  ) and exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.calendar_rooms;
  end if;
end $$;

comment on table public.calendar_rooms is
  'Sala da clínica — o recurso que um compromisso ocupa (migration 0200). schedule nulo = herda calendar_settings.default_schedule.';
comment on table public.calendar_settings is
  'Configuração da Agenda por organização (migration 0200): horário de funcionamento padrão que as salas herdam.';
comment on table public.calendar_event_type_rooms is
  'Em quais salas cada serviço pode ser feito. Nenhuma linha para o serviço = qualquer sala.';
comment on column public.calendar_appointments.room_id is
  'Sala ocupada (migration 0200). Nulável só por compatibilidade com a imagem antiga do app durante o deploy; o app sempre grava.';
comment on column public.calendar_appointments.owner_user_id is
  'Profissional que atende — OPCIONAL e informativo desde a 0200 (a sala é quem trava o horário).';

notify pgrst, 'reload schema';
