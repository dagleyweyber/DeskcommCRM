-- 0159_meta_ads_credentials — Meta Ads, Fase C1: credenciais por tenant +
-- log do envio automático de Purchase.
--
-- Duas tabelas novas, sem função SECURITY DEFINER nova (RLS usa os helpers
-- já existentes fn_user_org_ids/fn_role_at_least/fn_is_platform_admin) —
-- não se aplica aqui a doutrina de "função nova nasce exposta".
--
-- tenant_meta_ads_credentials: NÃO reaproveita tenant_integrations — o
-- CHECK de provider de lá é fechado em nuvemshop/vtex/shopify, e os campos
-- obrigatórios (webhook_secret_encrypted NOT NULL, ciclo de refresh OAuth)
-- modelam integração de e-commerce com webhook inbound. Meta Conversions
-- API é outbound-only, sem refresh token automático. Token cifrado com
-- fn_encrypt_oauth (mesmo mecanismo de lib/webhooks/secrets.ts) — não o
-- AES-GCM de ai_provider_credentials, que é mecanismo separado.
--
-- meta_capi_send_log: append-only, só do envio AUTOMÁTICO de Purchase
-- (lead.won → handler novo, sem passar por automation_rules). A Fase C2
-- (ação `meta_capi` dentro de regra, pra "lead qualificado") reaproveita
-- o log que automation_rule_runs JÁ tem — não duplica aqui.
--
-- TABELA NOVA NASCE CONCEDIDA A anon, não só função: o `ALTER DEFAULT
-- PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline vale pra toda
-- tabela (e view) criada depois dele — revogado explicitamente no fim de
-- cada bloco (mesmo padrão de `org_guardrail_layers`, migration 0143).
-- RLS sozinha não bastaria pra provar isso num teste: teste de RLS prova
-- isolamento ENTRE tenants, não que `anon` está de fora.
create table if not exists public.tenant_meta_ads_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  access_token_encrypted bytea not null,
  dataset_id text not null,
  status text not null default 'connecting',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_meta_ads_credentials_status_check
    check (status in ('connecting', 'healthy', 'invalid', 'error')),
  constraint tenant_meta_ads_credentials_org_unique unique (organization_id)
);

create or replace trigger trg_tenant_meta_ads_credentials_updated_at
  before update on public.tenant_meta_ads_credentials
  for each row execute function public.fn_set_updated_at();

alter table public.tenant_meta_ads_credentials enable row level security;

-- `create policy` não tem IF NOT EXISTS — drop antes é o que torna o
-- bloco reaplicável pelo update.sh sem "policy already exists".
drop policy if exists tenant_meta_ads_credentials_select on public.tenant_meta_ads_credentials;
drop policy if exists tenant_meta_ads_credentials_write on public.tenant_meta_ads_credentials;

create policy tenant_meta_ads_credentials_select
  on public.tenant_meta_ads_credentials for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy tenant_meta_ads_credentials_write
  on public.tenant_meta_ads_credentials
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

revoke all on public.tenant_meta_ads_credentials from anon;

-- View segura: nunca expõe access_token_encrypted — mesmo padrão de
-- ai_provider_credentials_safe. É o que a tela de configurações lê.
create or replace view public.tenant_meta_ads_credentials_safe as
select id, organization_id, dataset_id, status, last_error, created_at, updated_at
from public.tenant_meta_ads_credentials;

revoke all on public.tenant_meta_ads_credentials_safe from anon;

create table if not exists public.meta_capi_send_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  event_name text not null,
  status text not null,
  meta_error text,
  created_at timestamptz not null default now(),
  constraint meta_capi_send_log_status_check check (status in ('sent', 'failed', 'skipped'))
);

create index if not exists idx_meta_capi_send_log_org_created
  on public.meta_capi_send_log (organization_id, created_at);

alter table public.meta_capi_send_log enable row level security;

drop policy if exists meta_capi_send_log_select on public.meta_capi_send_log;

create policy meta_capi_send_log_select
  on public.meta_capi_send_log for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Só o service_role escreve (o handler roda com admin client, bypassa RLS
-- de qualquer forma) — sem policy de INSERT/UPDATE/DELETE pro usuário
-- autenticado, mesmo padrão de api_audit_log (append-only só de dentro).

revoke all on public.meta_capi_send_log from anon;
