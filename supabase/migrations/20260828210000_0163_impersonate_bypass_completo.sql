-- 0163_impersonate_bypass_completo — impersonate (S-11.07) quebrava em
-- QUALQUER mutação que emitisse evento, não só a que o cliente reportou.
--
-- Achado ao vivo: admin de plataforma impersonando um tenant tentou trocar o
-- "Atendente" de um lead (B'Laser Caruaru) e levou "Erro interno". A causa
-- raiz NÃO era RLS (a política de crm_leads já tem `fn_is_platform_admin()`
-- desde a 0036/0037) — era o TRIGGER `fn_emit_event_on_lead_change`, que
-- chama `emit_event(...)`, e essa função tem seu PRÓPRIO gate de
-- autorização, SEPARADO da RLS: `fn_role_at_least(org, 'viewer')` sem
-- bypass nenhum pra admin de plataforma. Ele nunca é membro real de
-- `user_organizations` do tenant — impersonate não cria linha lá, de
-- propósito (é ADITIVO à sessão, não altera quem está autenticado) — então
-- toda vez que uma mutação em `crm_leads`/`conversations`/`messages` dispara
-- um evento, essa função barra o próprio admin de plataforma.
--
-- Varredura completa (não só o caso reportado) achou o MESMO anti-padrão em
-- mais TRÊS funções `security definer` e em sete conjuntos de política de
-- RLS que nunca tiveram o bypass — a 0150 (comentário nas linhas em torno de
-- "ai_agent_versions"/"ai_routers") só *preservava* `fn_is_platform_admin()`
-- onde já existia, não o adicionava onde faltava.
--
-- **Funções corrigidas** (adiciona `or public.fn_is_platform_admin()` ao
-- gate; corpo e demais assinaturas idênticas — `create or replace` puro):
--   - `emit_event` — dezenas de chamadores (create/update/tag de lead,
--     trigger de atribuição, mensagens); é a de maior impacto.
--   - `fn_member_role_in_org` — achada TESTANDO o fix de baixo: sem ela, o
--     admin de plataforma atribuindo a um agent+ ELEGÍVEL DE VERDADE levava
--     'assignee_not_eligible_member' — mentira atrás da mentira (a função só
--     responde o papel do DESTINATÁRIO se o CHAMADOR também for membro).
--   - `retrieve_top_k_chunks` — RAG de agente de IA.
--   - `fn_conversation_assign` — só o gate do CHAMADOR; o gate do
--     DESTINATÁRIO (`assignee_not_eligible_member`) fica como está de
--     propósito — atribuir a alguém que não é agent+ de verdade continua
--     errado mesmo em impersonate, isso é sobre o dado, não sobre quem pede.
--
-- **Políticas de RLS corrigidas** (`or public.fn_is_platform_admin()` no
-- USING/WITH CHECK): `message_templates_write`, `conversation_notes_write`,
-- `ai_agent_versions` (select+write), `ai_routers` (select+write),
-- `ai_router_members` (select+write), `ai_purpose_bindings` (select+write),
-- `ai_provider_credentials_write`. `create policy` não tem IF NOT EXISTS —
-- `drop policy if exists` antes de cada uma, mesmo padrão de sempre.
create or replace function public.emit_event(
  p_event_type text,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null
) returns uuid
  language plpgsql security definer
  set search_path to 'public'
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_is_platform_admin()
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;

-- Achado testando o fix acima: `fn_conversation_assign` recusava o admin de
-- plataforma atribuindo a um agent+ ELEGÍVEL DE VERDADE, com
-- 'assignee_not_eligible_member' — mentira por trás da mentira. Essa função
-- chama `fn_member_role_in_org(p_to_user_id, p_org)` pra saber o papel do
-- DESTINATÁRIO, e essa função tem SEU PRÓPRIO gate: só responde se quem
-- CHAMA (`auth.uid()`) também for membro da mesma org — mesmo anti-padrão,
-- uma camada mais fundo. Sem ser membro, o admin de plataforma recebe NULL
-- do papel do destinatário (nunca vê a linha), e o `coalesce(..., 'none')`
-- de `fn_conversation_assign` interpreta "não vi" como "não é elegível".
create or replace function public.fn_member_role_in_org(p_user uuid, p_org uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select uo.role
    from public.user_organizations uo
   where uo.user_id = p_user
     and uo.organization_id = p_org
     and uo.revoked_at is null
     and (
       auth.uid() is null
       or public.fn_is_platform_admin()
       or exists (
         select 1 from public.user_organizations me
          where me.user_id = auth.uid()
            and me.organization_id = p_org
            and me.revoked_at is null
       )
     )
   limit 1;
$$;

create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40
) returns table (
  chunk_id uuid,
  knowledge_source_id uuid,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_is_platform_admin()
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'retrieve_top_k_chunks: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  where c.organization_id = p_organization_id
    and c.kb_version_id   = p_kb_version_id
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_is_platform_admin()
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  -- Gate do DESTINATÁRIO, sem bypass de propósito: atribuir a alguém que não
  -- é agent+ de verdade continua errado mesmo em impersonate — é sobre o
  -- dado, não sobre quem pede.
  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

-- ---- políticas de RLS sem o bypass (nunca tiveram, não é regressão da 0150) ----

drop policy if exists "message_templates_write" on message_templates;
create policy "message_templates_write" on message_templates
  for all using (
    fn_is_platform_admin()
    or (
      organization_id in (select fn_user_org_ids())
      and (
        (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
        or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
      )
    )
  )
  with check (
    fn_is_platform_admin()
    or (
      organization_id in (select fn_user_org_ids())
      and (
        (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
        or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
      )
    )
  );

drop policy if exists "conversation_notes_write" on conversation_notes;
create policy "conversation_notes_write" on conversation_notes
  for all using (
    fn_is_platform_admin()
    or (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    fn_is_platform_admin()
    or (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists tenant_isolation_ai_agent_versions_select on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_select on public.ai_agent_versions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_agent_versions_write on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_write on public.ai_agent_versions
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists tenant_isolation_ai_routers_select on public.ai_routers;
create policy tenant_isolation_ai_routers_select on public.ai_routers
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_routers_write on public.ai_routers;
create policy tenant_isolation_ai_routers_write on public.ai_routers
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists tenant_isolation_ai_router_members_select on public.ai_router_members;
create policy tenant_isolation_ai_router_members_select on public.ai_router_members
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_router_members_write on public.ai_router_members;
create policy tenant_isolation_ai_router_members_write on public.ai_router_members
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
  );

notify pgrst, 'reload schema';
