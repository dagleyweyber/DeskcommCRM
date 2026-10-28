-- 0202_lead_touchpoints — de onde o lead veio, em campos estruturados.
--
-- Medido em produção (2026-10-27, 90 dias): 611 de 630 leads de anúncio do WhatsApp
-- tinham o anúncio identificado; os 19 leads de landing page não tinham NENHUM dado
-- de origem. E a origem que existia morava em `crm_leads.source_metadata` (JSON solto,
-- sobrescrito quando um clique novo reabre o lead).
--
-- Cada ponto de contato vira uma linha: canal, identificador de clique, UTMs e os IDs
-- de campanha / conjunto / anúncio. Um lead pode ter vários (primeiro e último toque).
-- Os NOMES de campanha/conjunto/anúncio da Meta continuam vindo de
-- `meta_ads_ad_metadata` (resolvidos pela API a partir do ad_id); aqui ficam os nomes
-- que vieram na própria URL (o caminho do Google e de quem não conectou a leitura).
--
-- `canal` e `via` são vocabulário ABERTO (sem CHECK) — vivem em
-- `lib/atribuicao/ponto-de-contato.ts` (constantes CANAL e VIA).
--
-- `crm_leads.source_metadata` continua sendo gravado como antes: o envio ao Meta
-- Conversions API, o dashboard por anúncio e a resolução de hierarquia o leem hoje.

create table if not exists public.lead_touchpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  canal text not null,
  via text not null,
  click_id_type text,
  click_id text,
  fbc text,
  fbp text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  campaign_id text,
  adset_id text,
  ad_id text,
  campaign_name text,
  adset_name text,
  ad_name text,
  keyword text,
  landing_url text,
  referrer text,
  client_user_agent text,
  extras jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_touchpoints_lead
  on public.lead_touchpoints (organization_id, lead_id, occurred_at);
create index if not exists idx_lead_touchpoints_campanha
  on public.lead_touchpoints (organization_id, canal, campaign_id);
create index if not exists idx_lead_touchpoints_anuncio
  on public.lead_touchpoints (organization_id, ad_id);

alter table public.lead_touchpoints enable row level security;

-- Leitura: membros da organização (e o admin de plataforma, como nas demais tabelas
-- de leitura do Meta Ads). Escrita: só o servidor (service_role), sem policy de
-- escrita para usuário — atribuição não é editada à mão.
drop policy if exists tenant_isolation_lead_touchpoints_select on public.lead_touchpoints;
create policy tenant_isolation_lead_touchpoints_select
  on public.lead_touchpoints for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Tabela nova nasce concedida a anon pelos default privileges do baseline.
revoke all on public.lead_touchpoints from anon;

-- Histórico: o que já estava em source_metadata vira o primeiro ponto de contato do
-- lead. Idempotente — só lead que ainda não tem nenhum ponto de contato.
insert into public.lead_touchpoints (
  organization_id, lead_id, contact_id, canal, via, click_id_type, click_id,
  fbc, fbp, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  campaign_id, adset_id, ad_id, keyword, landing_url, extras, occurred_at
)
select
  l.organization_id,
  l.id,
  l.contact_id,
  case
    when m ? 'ad_click_id' or (m ? 'ad_id' and m ? 'ad_headline') then 'meta_ads'
    when m ? 'gclid' or m ? 'gbraid' or m ? 'wbraid' then 'google_ads'
    when m ? 'fbclid' or m ? 'fbc' then 'meta_ads'
    when lower(coalesce(m->>'utm_source', '')) in ('google', 'googleads', 'google_ads', 'adwords', 'gads', 'youtube') then 'google_ads'
    when lower(coalesce(m->>'utm_source', '')) in ('facebook', 'fb', 'meta', 'instagram', 'ig', 'facebook_ads', 'meta_ads') then 'meta_ads'
    when lower(coalesce(m->>'utm_source', '')) in ('tiktok', 'tiktok_ads', 'tt') then 'tiktok_ads'
    else 'outro'
  end,
  case when m ? 'ad_click_id' or (m ? 'ad_id' and m ? 'ad_headline') then 'anuncio_whatsapp' else 'historico' end,
  case
    when m->>'ad_click_id_type' = 'ctwa_clid' then 'ctwa_clid'
    when m ? 'gclid' then 'gclid'
    when m ? 'gbraid' then 'gbraid'
    when m ? 'wbraid' then 'wbraid'
    when m ? 'fbclid' then 'fbclid'
  end,
  coalesce(m->>'ad_click_id', m->>'gclid', m->>'gbraid', m->>'wbraid', m->>'fbclid'),
  m->>'fbc',
  m->>'fbp',
  m->>'utm_source',
  m->>'utm_medium',
  m->>'utm_campaign',
  m->>'utm_content',
  m->>'utm_term',
  m->>'campaign_id',
  coalesce(m->>'adset_id', m->>'adgroup_id'),
  coalesce(m->>'ad_id', m->>'creative'),
  m->>'keyword',
  coalesce(m->>'ad_source_url', m->>'landing_url', m->>'page_url'),
  case when m ? 'ad_headline' then jsonb_build_object('ad_headline', m->>'ad_headline') else '{}'::jsonb end,
  l.created_at
from public.crm_leads l
cross join lateral (select l.source_metadata as m) s
where (
    m ? 'ad_id' or m ? 'ad_click_id' or m ? 'gclid' or m ? 'gbraid' or m ? 'wbraid'
    or m ? 'fbclid' or m ? 'fbc' or m ? 'utm_source' or m ? 'campaign_id'
  )
  and not exists (select 1 from public.lead_touchpoints t where t.lead_id = l.id);

notify pgrst, 'reload schema';
