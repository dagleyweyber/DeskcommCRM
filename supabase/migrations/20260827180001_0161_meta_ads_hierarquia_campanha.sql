-- 0161_meta_ads_hierarquia_campanha — Meta Ads, Fase E1: schema pra ler
-- campanha/conjunto/anúncio de um ad_id (não só receita por anúncio isolado).
--
-- Duas peças novas:
--
-- 1. `tenant_meta_ads_credentials.ads_read_token_encrypted` (coluna nova,
--    nullable): segundo token, INDEPENDENTE do `access_token_encrypted` que
--    a Fase C1 já usa pra mandar Purchase. Motivo de serem dois tokens, não
--    um: o token gerado pelo botão "Gerar token de acesso" do Gerenciador de
--    Eventos (usado na Fase C1) só carrega a permissão `read_ads_dataset_
--    quality` — não `ads_read`/`ads_management`, então não enxerga campanha/
--    conjunto/anúncio via Marketing API. Exigir reconectar o token da Fase
--    C1 pra ampliar o escopo arriscaria quebrar o envio de Purchase que já
--    funciona; token novo e opcional é estritamente aditivo. Mesma tabela
--    (não uma nova) porque é o mesmo conceito — uma integração Meta Ads por
--    org — com o mesmo dono e ciclo de vida (cai junto se a org desconectar).
--
-- 2. `meta_ads_ad_metadata`: cache — ad_id -> nome do anúncio + conjunto +
--    campanha. Resolvido em segundo plano (Fase E2, handler de `lead.created`
--    reagindo a leads com source_metadata.ad_id), nunca no caminho do
--    webhook. Nomes de campanha não mudam com frequência que justifique
--    refetch por lead; cache permanente com UNIQUE (organization_id, ad_id).
create table if not exists public.meta_ads_ad_metadata (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ad_id text not null,
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  fetched_at timestamptz not null default now(),
  last_error text,
  constraint meta_ads_ad_metadata_org_ad_unique unique (organization_id, ad_id)
);

create index if not exists idx_meta_ads_ad_metadata_org
  on public.meta_ads_ad_metadata (organization_id);

alter table public.tenant_meta_ads_credentials
  add column if not exists ads_read_token_encrypted bytea;

alter table public.meta_ads_ad_metadata enable row level security;

-- `create policy` não tem IF NOT EXISTS — drop antes é o que torna o bloco
-- reaplicável pelo update.sh sem "policy already exists".
drop policy if exists meta_ads_ad_metadata_select on public.meta_ads_ad_metadata;

create policy meta_ads_ad_metadata_select
  on public.meta_ads_ad_metadata for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Só o service_role escreve (o handler de resolução roda com admin client,
-- bypassa RLS de qualquer forma) — sem policy de INSERT/UPDATE/DELETE pro
-- usuário autenticado, mesmo padrão de meta_capi_send_log (migration 0159).

-- TABELA NOVA NASCE CONCEDIDA A anon, não só função — revogado explicitamente
-- (mesmo padrão de tenant_meta_ads_credentials, migration 0159).
revoke all on public.meta_ads_ad_metadata from anon;

-- View segura precisa refletir a coluna nova sem NUNCA expor o bytea cifrado
-- — `create or replace view` com a MESMA lista de colunas + um booleano
-- derivado, nunca o token em si.
create or replace view public.tenant_meta_ads_credentials_safe as
select
  id,
  organization_id,
  dataset_id,
  status,
  last_error,
  created_at,
  updated_at,
  (ads_read_token_encrypted is not null) as ads_read_connected
from public.tenant_meta_ads_credentials;

revoke all on public.tenant_meta_ads_credentials_safe from anon;

notify pgrst, 'reload schema';
