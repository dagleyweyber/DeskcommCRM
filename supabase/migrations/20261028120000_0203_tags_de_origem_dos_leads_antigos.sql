-- 0203 — tags de origem (origem:, campanha:, anuncio:) nos leads que já existem.
--
-- Rastreamento de campanha, Fase 3. O código novo (lib/atribuicao/aplicar-tags.ts)
-- põe essas tags em quem nasce a partir de agora; esta migration faz o mesmo para os
-- leads que já tinham ponto de contato (lead_touchpoints, migration 0202) — sem ela, o
-- filtro "Origem: Instagram" do Kanban só enxergaria os leads novos.
--
-- Só DADOS: nenhuma tabela, coluna ou função nova. Nada de schema para os clones
-- aplicarem além deste UPDATE.
--
-- A MESMA regra do código, de propósito (qualquer mudança aqui pede a mesma lá):
--   • vale o PRIMEIRO ponto de contato de mídia paga do lead (canal ≠ 'outro');
--   • Origem é aditiva: meta_ads → origem:meta-ads, e também origem:instagram quando o
--     utm_source é instagram/ig ou o link (landing_url) / referenciador é do Instagram;
--     google_ads → origem:google-ads; tiktok_ads → origem:tiktok-ads;
--   • campanha:/anuncio: só com NOME (o do ponto, ou o que a Meta devolveu em
--     meta_ads_ad_metadata), exato, até 80 caracteres;
--   • grupo que o lead já tem fica como está (primeiro toque ganha; correção manual vale).
--
-- NÃO emite evento: lead.tag_added aciona automações já configuradas, e esta é
-- classificação derivada, não ação de alguém. O gatilho trg_emit_event_on_lead_change
-- só emite por mudança de status ou de responsável — não por tag.
--
-- Idempotente: rodar de novo não acrescenta nada (cada grupo só entra se ainda não existe).
-- Genérica: nada de id de organização; funciona em qualquer banco.

with primeiro as (
  select distinct on (t.lead_id)
    t.lead_id, t.organization_id, t.canal, t.utm_source, t.landing_url, t.referrer,
    t.campaign_name, t.ad_name, t.ad_id
  from public.lead_touchpoints t
  where t.canal in ('meta_ads', 'google_ads', 'tiktok_ads')
  order by t.lead_id, t.occurred_at asc, t.created_at asc
), calc as (
  select
    p.lead_id,
    p.organization_id,
    p.canal,
    (p.canal = 'meta_ads' and (
        lower(btrim(coalesce(p.utm_source, ''))) in ('instagram', 'ig')
        or substring(p.landing_url from '^https?://([^/?#:@]+)') ~* '(^|\.)instagram\.com$'
        or substring(p.referrer from '^https?://([^/?#:@]+)') ~* '(^|\.)instagram\.com$'
    )) as instagram,
    nullif(btrim(left(btrim(regexp_replace(coalesce(p.campaign_name, m.campaign_name, ''), '\s+', ' ', 'g')), 80)), '') as campanha,
    nullif(btrim(left(btrim(regexp_replace(coalesce(p.ad_name, m.ad_name, ''), '\s+', ' ', 'g')), 80)), '') as anuncio
  from primeiro p
  left join public.meta_ads_ad_metadata m
    on p.canal = 'meta_ads' and m.organization_id = p.organization_id and m.ad_id = p.ad_id
), faltando as (
  select
    c.*,
    not exists (select 1 from public.crm_leads l, unnest(l.tags) x where l.id = c.lead_id and x like 'origem:%') as sem_origem,
    not exists (select 1 from public.crm_leads l, unnest(l.tags) x where l.id = c.lead_id and x like 'campanha:%') as sem_campanha,
    not exists (select 1 from public.crm_leads l, unnest(l.tags) x where l.id = c.lead_id and x like 'anuncio:%') as sem_anuncio
  from calc c
)
update public.crm_leads l
set tags = l.tags
  || case
       when not f.sem_origem then '{}'::text[]
       when f.canal = 'meta_ads' and f.instagram then array['origem:meta-ads', 'origem:instagram']
       when f.canal = 'meta_ads' then array['origem:meta-ads']
       when f.canal = 'google_ads' then array['origem:google-ads']
       else array['origem:tiktok-ads']
     end
  || case when f.campanha is not null and f.sem_campanha then array['campanha:' || f.campanha] else '{}'::text[] end
  || case when f.anuncio is not null and f.sem_anuncio then array['anuncio:' || f.anuncio] else '{}'::text[] end
from faltando f
where l.id = f.lead_id
  and l.organization_id = f.organization_id
  and (f.sem_origem or (f.campanha is not null and f.sem_campanha) or (f.anuncio is not null and f.sem_anuncio));
