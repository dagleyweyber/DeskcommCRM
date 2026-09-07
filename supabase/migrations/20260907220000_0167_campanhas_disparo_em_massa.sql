-- 0167_campanhas_disparo_em_massa — disparo de template aprovado pra uma
-- lista de leads/contatos.
--
-- Até aqui o canal oficial só manda um template aprovado de cada vez, abrindo
-- a conversa de um contato por vez no Inbox (`JanelaFechadaAviso.tsx`). Não
-- existe "escolher um público e disparar pra todos" — o pedido do usuário.
--
-- Duas tabelas, não uma: `whatsapp_campaigns` é a intenção (o quê, pra quem,
-- com que template) e `whatsapp_campaign_recipients` é o PÚBLICO
-- MATERIALIZADO — resolvido uma vez, na criação, não reavaliado a cada tick
-- do despachante. Se fosse uma consulta ao vivo, um contato que muda de
-- etapa no meio do disparo entraria ou sairia da campanha sem o operador
-- perceber; "campanha" significa "este público, agora".
--
-- `organization_id` também em `whatsapp_campaign_recipients` (denormalizado,
-- não só via join com a campanha): todo RLS deste repo filtra a tabela pela
-- própria coluna, e o despachante (service role) varre por ela direto sem
-- precisar de join pra saber de quem é cada linha.
create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  channel_session_id uuid not null references public.channel_sessions(id),
  template_name text not null,
  template_language text not null,
  -- `{[slotKey]: {kind:'fixed', value} | {kind:'contact_name'|'contact_first_name'}}`
  -- — resolvido POR DESTINATÁRIO na criação (`resolved_values` abaixo), não em
  -- tempo de envio. O despachante não precisa saber nada de contato.
  variable_mapping jsonb not null default '{}'::jsonb,
  -- Snapshot do critério escolhido — só para a tela reexibir o que foi usado.
  -- Quem manda de verdade é a lista já materializada em `_recipients`.
  audience_filter jsonb not null,
  status text not null default 'draft',
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_by uuid references auth.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_campaigns_status_check
    check (status in ('draft', 'queued', 'running', 'paused', 'completed', 'cancelled'))
);

create or replace trigger trg_whatsapp_campaigns_updated_at
  before update on public.whatsapp_campaigns
  for each row execute function public.fn_set_updated_at();

create index if not exists whatsapp_campaigns_org_status_idx
  on public.whatsapp_campaigns (organization_id, status);

alter table public.whatsapp_campaigns enable row level security;

drop policy if exists whatsapp_campaigns_select on public.whatsapp_campaigns;
drop policy if exists whatsapp_campaigns_write on public.whatsapp_campaigns;

create policy whatsapp_campaigns_select
  on public.whatsapp_campaigns for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Piso `manager`: disparo em massa é ação de gestor, mesmo piso do `assign`
-- em lote de leads (`app/api/v1/leads/bulk/route.ts`).
create policy whatsapp_campaigns_write
  on public.whatsapp_campaigns
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on public.whatsapp_campaigns from anon;

create table if not exists public.whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id),
  lead_id uuid references public.crm_leads(id),
  resolved_values jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  external_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_campaign_recipients_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'))
);

-- É o que o despachante varre a cada tick: "os `pending` desta campanha".
create index if not exists whatsapp_campaign_recipients_campaign_status_idx
  on public.whatsapp_campaign_recipients (campaign_id, status);

alter table public.whatsapp_campaign_recipients enable row level security;

drop policy if exists whatsapp_campaign_recipients_select on public.whatsapp_campaign_recipients;
drop policy if exists whatsapp_campaign_recipients_write on public.whatsapp_campaign_recipients;

create policy whatsapp_campaign_recipients_select
  on public.whatsapp_campaign_recipients for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy whatsapp_campaign_recipients_write
  on public.whatsapp_campaign_recipients
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on public.whatsapp_campaign_recipients from anon;

notify pgrst, 'reload schema';
