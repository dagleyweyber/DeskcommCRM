-- 0216 — links do botão escolhidos na hora da campanha.
--
-- A Meta fixa o endereço do botão de link na APROVAÇÃO do modelo (só o final pode
-- ser variável) e recusa link do WhatsApp no botão ("Direct links to WhatsApp
-- aren't allowed for buttons"). O dono do produto quer aprovar o modelo uma vez e
-- escolher o destino em cada campanha — inclusive o grupo VIP do WhatsApp.
--
-- A saída: o modelo é aprovado com um link do próprio CRM, `<crm>/l/{{1}}`. Ao
-- criar a campanha, o destino colado vira uma linha aqui com um código curto, e o
-- código é o valor do `{{1}}`. A rota pública `/l/<código>` conta o clique e
-- redireciona (`app/l/[codigo]/route.ts`).
--
-- Escrita só pelo servidor (service_role): a criação da campanha grava, a rota
-- pública conta o clique por `fn_registrar_clique_do_link`. Leitura por membro da
-- organização. Código é único no banco inteiro: o link público não diz de qual
-- organização ele é.
--
-- Idempotente: pode ser re-aplicada sem efeito.

create table if not exists public.whatsapp_campaign_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.whatsapp_campaigns(id) on delete cascade,
  codigo text not null check (codigo ~ '^[A-Za-z0-9]{8,32}$'),
  destino text not null check (destino ~* '^https?://' and length(destino) <= 2048),
  cliques integer not null default 0,
  ultimo_clique_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_campaign_links_codigo_unico unique (codigo)
);

create index if not exists idx_whatsapp_campaign_links_campanha
  on public.whatsapp_campaign_links (campaign_id);

alter table public.whatsapp_campaign_links enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_links_select on public.whatsapp_campaign_links;
create policy tenant_isolation_whatsapp_campaign_links_select
  on public.whatsapp_campaign_links for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

revoke all on public.whatsapp_campaign_links from anon;

-- Conta o clique e devolve o destino, numa ida só e sem corrida entre cliques.
-- `null` = código desconhecido. plpgsql (não sql) porque o corpo só é resolvido na
-- execução: no baseline a função vem antes da tabela (precisa ficar antes da
-- varredura de anon, e a tabela depende de whatsapp_campaigns, criada depois dela).
create or replace function public.fn_registrar_clique_do_link(p_codigo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_destino text;
begin
  update public.whatsapp_campaign_links
     set cliques = cliques + 1,
         ultimo_clique_at = now()
   where codigo = p_codigo
  returning destino into v_destino;
  return v_destino;
end;
$$;

revoke execute on function public.fn_registrar_clique_do_link(text) from public, anon;
revoke execute on function public.fn_registrar_clique_do_link(text) from authenticated;
grant execute on function public.fn_registrar_clique_do_link(text) to service_role;

notify pgrst, 'reload schema';
