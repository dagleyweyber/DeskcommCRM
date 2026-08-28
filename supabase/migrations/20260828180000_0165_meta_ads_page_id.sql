-- 0165_meta_ads_page_id — a Meta rejeita Purchase de CTWA sem o Facebook
-- Page ID do anuncio (erro real de producao, subcode 2804116: "Falta a
-- identificacao da Pagina ou a identificacao da conta do WhatsApp
-- Business"). O `page_id` e atributo do ANUNCIO (mesmo criativo, mesma
-- pagina), nao do lead — por isso entra em `meta_ads_ad_metadata` (Fase E1),
-- resolvido e cacheado junto com campanha/conjunto (Fase E2), nao numa
-- tabela nova.
alter table public.meta_ads_ad_metadata
  add column if not exists page_id text;
