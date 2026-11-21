-- 0224 — Integrações de agenda Uno e Zandu (além do Belle).
--
-- Pedido do dono do produto (2026-11-21): o menu "Belle" vira "Integrações", com
-- Belle, Uno e Zandu. O objetivo é o mesmo do Belle: todo agendamento feito no
-- sistema da clínica aparece sozinho na Agenda do CRM.
--
-- ─── A diferença para o Belle ───────────────────────────────────────────────
-- O Belle não avisa nada: o CRM relê a agenda dele de tempos em tempos. Uno e Zandu
-- AVISAM — mandam um POST (webhook) a cada agendamento criado, alterado ou removido.
-- Então a conexão deles ganha um endereço de recebimento próprio
-- (`inbound_path_token`, que resolve a organização — nunca o corpo do aviso) e,
-- no Uno, o token que ele manda no cabeçalho `X-UNO-Webhook-Token` (guardado só
-- como hash SHA-256).
--
-- O aviso é gravado em `calendar_integration_events` ANTES de ser processado: o Uno
-- tenta uma vez só e espera 10 s. Aviso que falhar ao processar fica na tabela e o
-- cron da agenda externa tenta de novo.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
--  1. `calendar_integrations.provider` aceita 'uno' e 'zandu'.
--  2. Credencial e conta externa deixam de ser obrigatórias: o Uno não precisa de
--     credencial para receber aviso, e a conta só é conhecida no 1º aviso.
--  3. `calendar_appointments.external_provider` aceita 'uno' e 'zandu'.
--  4. Tabela `calendar_integration_events` (avisos recebidos).
-- Só afrouxa regras e acrescenta: nenhum dado existente é tocado.
-- ============================================================================

-- 1 + 2. A conexão
alter table public.calendar_integrations drop constraint if exists calendar_integrations_provider_check;
alter table public.calendar_integrations
  add constraint calendar_integrations_provider_check check (provider in ('belle', 'uno', 'zandu'));

alter table public.calendar_integrations alter column credential_encrypted drop not null;
alter table public.calendar_integrations alter column credential_last4 drop not null;
alter table public.calendar_integrations alter column external_account_id drop not null;

alter table public.calendar_integrations add column if not exists inbound_path_token text;
alter table public.calendar_integrations add column if not exists inbound_secret_hash text;

create unique index if not exists uniq_calendar_integrations_inbound_path_token
  on public.calendar_integrations (inbound_path_token)
  where inbound_path_token is not null;

comment on column public.calendar_integrations.inbound_path_token is
  'Uno/Zandu: segredo do endereço que recebe os avisos (/api/v1/webhooks/agenda/<token>). Resolve a organização. Migration 0224.';
comment on column public.calendar_integrations.inbound_secret_hash is
  'Uno: SHA-256 (hex) do token que o Uno manda em X-UNO-Webhook-Token. O texto puro é mostrado uma vez só. Migration 0224.';

-- 3. De onde veio o compromisso
alter table public.calendar_appointments drop constraint if exists calendar_appointments_external_provider_check;
alter table public.calendar_appointments
  add constraint calendar_appointments_external_provider_check
  check (external_provider is null or external_provider in ('belle', 'uno', 'zandu'));

-- 4. Avisos recebidos
create table if not exists public.calendar_integration_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null references public.calendar_integrations(id) on delete cascade,
  event_type text,
  external_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

comment on table public.calendar_integration_events is
  'Avisos (webhooks) de agendamento recebidos do Uno/Zandu. Gravados antes de processar; o cron reprocessa os pendentes. Migration 0224.';

create index if not exists idx_calendar_integration_events_pendentes
  on public.calendar_integration_events (received_at)
  where processed_at is null;

create index if not exists idx_calendar_integration_events_integracao
  on public.calendar_integration_events (integration_id, received_at desc);

alter table public.calendar_integration_events enable row level security;

drop policy if exists calendar_integration_events_select on public.calendar_integration_events;
create policy calendar_integration_events_select
  on public.calendar_integration_events for select
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

-- Escrita só pelo servidor (service role, que ignora RLS).
revoke all on public.calendar_integration_events from anon;
revoke insert, update, delete on public.calendar_integration_events from authenticated;

notify pgrst, 'reload schema';
