-- 0203 — cliques no WhatsApp da landing page: a ponte entre o clique no anúncio e a conversa.
--
-- Rastreamento de campanha, Fase 4a. O Google (diferente da Meta) NÃO entrega nenhum
-- identificador quando a pessoa chega ao WhatsApp: o anúncio leva a uma landing page, a
-- pessoa clica no botão do WhatsApp, e o gclid fica na página — a conversa nasce sem
-- origem, e a conversão offline nunca volta ao Google.
--
-- A ponte: o script da landing page (public/rastreio.js) acrescenta um código curto ao
-- texto do link do WhatsApp ("... ref:K7M2QX") e registra aqui o clique com os parâmetros
-- do anúncio. Quando a mensagem chega ao CRM com o código, a conversa é ligada a este
-- clique (lib/atribuicao/ligar-clique.ts) e vira um ponto de contato em lead_touchpoints.
--
-- Escrita só pelo servidor (service_role) — a rota pública valida o token da fonte e
-- limita a taxa. Leitura por membro da organização (diagnóstico: quantos cliques foram
-- ligados a uma conversa). Sem política de escrita para authenticated.
--
-- `parametros` guarda os parâmetros de anúncio JÁ filtrados por allowlist (UTMs, ids,
-- gclid/fbclid…), nunca o corpo cru. Código é único por organização.
--
-- Idempotente: pode ser re-aplicada sem efeito.

create table if not exists public.rastreio_cliques (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  codigo text not null check (codigo ~ '^[A-HJ-NP-Z2-9]{6}$'),
  parametros jsonb not null default '{}'::jsonb,
  landing_url text,
  client_user_agent text,
  created_at timestamptz not null default now(),
  usado_em timestamptz,
  lead_id uuid references public.crm_leads(id) on delete set null,
  constraint rastreio_cliques_codigo_unico unique (organization_id, codigo)
);

create index if not exists idx_rastreio_cliques_org_data
  on public.rastreio_cliques (organization_id, created_at desc);

alter table public.rastreio_cliques enable row level security;

drop policy if exists tenant_isolation_rastreio_cliques_select on public.rastreio_cliques;
create policy tenant_isolation_rastreio_cliques_select
  on public.rastreio_cliques for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

revoke all on public.rastreio_cliques from anon;

notify pgrst, 'reload schema';
