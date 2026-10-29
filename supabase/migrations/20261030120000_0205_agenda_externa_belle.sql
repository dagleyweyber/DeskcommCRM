-- 0205 — Agenda externa: importar os agendamentos do sistema de gestão da clínica (Belle).
--
-- Pedido do dono do produto (2026-10-29): clínicas que usam o Belle Software como
-- sistema de gestão querem ver na Agenda do CRM, sem digitar de novo, todo
-- agendamento feito lá — data, horário, serviço, sala e cliente.
--
-- ─── Quem manda ────────────────────────────────────────────────────────────
-- O Belle é a FONTE DA VERDADE do agendamento importado. O CRM espelha: remarcar,
-- cancelar e mudar status se faz lá; a sincronização traz o resultado. Dois
-- sistemas editando o mesmo horário é como a agenda diverge.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--  1. `calendar_integrations` — a conexão, uma por (organização, provedor). Genérica
--     de propósito: o provedor é uma coluna (hoje só 'belle'); outro sistema de
--     gestão entra como mais um valor, sem tabela nova. O token vai cifrado com
--     `fn_encrypt_oauth` (mesmo mecanismo do Meta Ads/webhooks) e a tela lê a view
--     `calendar_integrations_safe`, que nunca expõe o cifrado.
--  2. `calendar_appointments.external_provider/external_id/external_status` — de
--     onde veio, o código lá e o status como o Belle o nomeia ("Marcado",
--     "Em Andamento"…). O índice único (org, provedor, código) é a idempotência:
--     a mesma rodada repetida não duplica nada.
--  3. `calendar_rooms.external_provider/external_id` — a sala do Belle vira (ou
--     casa com) uma sala da Agenda. Ponteiro, não cópia do nome.
--  4. A trava de sala (0200) deixa de valer para o agendamento IMPORTADO. Medido
--     na B'Laser Parnamirim: 7 encaixes em 2.452 agendamentos de 60 dias — o Belle
--     permite e a clínica usa. Recusar o importado esconderia da Agenda um
--     horário que existe. A trava continua valendo entre os marcados NO CRM, e a
--     busca de horário livre (lib/agenda) segue contando o importado como ocupado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A conexão
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  credential_encrypted bytea not null,
  credential_last4 text not null,
  external_account_id text not null,
  external_account_name text,
  default_area_code text,
  status text not null default 'healthy',
  last_error text,
  last_sync_at timestamptz,
  last_sync_stats jsonb not null default '{}'::jsonb,
  initial_sync_done_at timestamptz,
  far_window_index integer not null default 0,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_integrations_provider_check check (provider in ('belle')),
  constraint calendar_integrations_status_check check (status in ('healthy', 'invalid', 'error')),
  constraint calendar_integrations_org_provider_unique unique (organization_id, provider)
);

comment on table public.calendar_integrations is
  'Conexão com a agenda de um sistema externo (Belle). Uma por organização e provedor. Migration 0205.';
comment on column public.calendar_integrations.initial_sync_done_at is
  'Fim da primeira importação. Antes disso nada vai para a timeline do negócio: o histórico entra em silêncio.';
comment on column public.calendar_integrations.far_window_index is
  'Rodízio das janelas distantes (a próxima semana é relida a toda rodada; o resto, uma fatia por vez).';

create or replace trigger trg_calendar_integrations_updated_at
  before update on public.calendar_integrations
  for each row execute function public.fn_set_updated_at();

alter table public.calendar_integrations enable row level security;

drop policy if exists calendar_integrations_select on public.calendar_integrations;
drop policy if exists calendar_integrations_write on public.calendar_integrations;

create policy calendar_integrations_select
  on public.calendar_integrations for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy calendar_integrations_write
  on public.calendar_integrations
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
    )
  );

revoke all on public.calendar_integrations from anon;

create or replace view public.calendar_integrations_safe
with (security_invoker = true) as
select id, organization_id, provider, credential_last4, external_account_id, external_account_name,
       default_area_code, status, last_error, last_sync_at, last_sync_stats, initial_sync_done_at,
       created_at, updated_at
  from public.calendar_integrations;

revoke all on public.calendar_integrations_safe from anon;

-- ---------------------------------------------------------------------------
-- 2. De onde veio o compromisso
-- ---------------------------------------------------------------------------
alter table public.calendar_appointments add column if not exists external_provider text;
alter table public.calendar_appointments add column if not exists external_id text;
alter table public.calendar_appointments add column if not exists external_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.calendar_appointments'::regclass
       and conname = 'calendar_appointments_external_provider_check'
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_external_provider_check
      check (external_provider is null or external_provider in ('belle'));
  end if;
end $$;

create unique index if not exists uniq_calendar_appointments_external
  on public.calendar_appointments (organization_id, external_provider, external_id)
  where external_id is not null;

comment on column public.calendar_appointments.external_provider is
  'Sistema de onde o compromisso foi importado (NULL = marcado no CRM). Importado é somente leitura no CRM. Migration 0205.';
comment on column public.calendar_appointments.external_status is
  'Status como o sistema de origem o nomeia (ex.: "Em Andamento"), além do `status` normalizado.';

-- ---------------------------------------------------------------------------
-- 3. A sala do sistema externo
-- ---------------------------------------------------------------------------
alter table public.calendar_rooms add column if not exists external_provider text;
alter table public.calendar_rooms add column if not exists external_id text;

create unique index if not exists uniq_calendar_rooms_external
  on public.calendar_rooms (organization_id, external_provider, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- 4. A trava de sala vale entre os compromissos marcados no CRM
-- ---------------------------------------------------------------------------
-- Reconstrução: só a cláusula `where` muda (acrescenta `external_provider is null`).
-- Afrouxa a regra — nenhum dado existente a viola, então não há auto-cura antes.
alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_sala_sem_sobreposicao;

alter table public.calendar_appointments
  add constraint calendar_appointments_sala_sem_sobreposicao
  exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed', 'declined', 'completed') and external_provider is null);

notify pgrst, 'reload schema';
