-- 0206 — Agenda externa: ligar o TIPO de serviço do Belle a um serviço da Agenda.
--
-- Pedido do dono do produto (2026-10-29): as automações de confirmação são por
-- serviço (um modelo de WhatsApp para depilação, outro para estética), e o
-- agendamento importado do Belle entrava SEM serviço do CRM — só a automação de
-- "todos os serviços" o alcançava, com um modelo único para todo mundo.
--
-- ─── O desenho ───────────────────────────────────────────────────────────────
--  1. `calendar_integration_service_links` — uma linha por tipo do Belle que já
--     apareceu ("Depilação", "Estética"; agendamento sem serviço vira o tipo do
--     agendamento: "Avaliação"). A sincronização CRIA a linha sozinha quando um
--     tipo novo surge (event_type_id nulo = "ainda não ligado"), e a tela mostra
--     o que falta ligar. Ligação é por TIPO e não por serviço: são ~5 tipos contra
--     331 serviços na B'Laser Parnamirim, e serviço novo do mesmo tipo já nasce
--     ligado.
--  2. `calendar_appointments.external_service_key` — a chave do tipo de CADA
--     agendamento importado. É o que permite, ao salvar uma ligação, corrigir
--     também os agendamentos já importados (não só os próximos).
--  3. Nada muda nas automações: com o serviço preenchido, a regra "o específico
--     vence o de todos os serviços" (0201) já faz o resto.
--
-- DIRC: a ligação é ponteiro (FK para o serviço, `on delete set null` — apagar o
-- serviço volta o tipo para "não ligado", nunca apaga a ligação nem o histórico).
-- ============================================================================

create table if not exists public.calendar_integration_service_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null references public.calendar_integrations(id) on delete cascade,
  external_key text not null,
  external_label text not null,
  event_type_id uuid references public.calendar_event_types(id) on delete set null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_integration_service_links_unique unique (integration_id, external_key)
);

comment on table public.calendar_integration_service_links is
  'Tipo de serviço do sistema externo (Belle) → serviço da Agenda. Linha criada pela sincronização; a ligação, pela tela. Migration 0206.';

create index if not exists idx_calendar_integration_service_links_org
  on public.calendar_integration_service_links (organization_id);

create or replace trigger trg_calendar_integration_service_links_updated_at
  before update on public.calendar_integration_service_links
  for each row execute function public.fn_set_updated_at();

alter table public.calendar_integration_service_links enable row level security;

drop policy if exists calendar_integration_service_links_select on public.calendar_integration_service_links;
drop policy if exists calendar_integration_service_links_write on public.calendar_integration_service_links;

create policy calendar_integration_service_links_select
  on public.calendar_integration_service_links for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy calendar_integration_service_links_write
  on public.calendar_integration_service_links
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

revoke all on public.calendar_integration_service_links from anon;

alter table public.calendar_appointments add column if not exists external_service_key text;

comment on column public.calendar_appointments.external_service_key is
  'Chave do tipo de serviço no sistema de origem (ver calendar_integration_service_links). Migration 0206.';

create index if not exists idx_calendar_appointments_external_service_key
  on public.calendar_appointments (organization_id, external_provider, external_service_key)
  where external_service_key is not null;

notify pgrst, 'reload schema';
