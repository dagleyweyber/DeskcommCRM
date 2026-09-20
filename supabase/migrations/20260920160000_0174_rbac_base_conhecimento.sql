-- 0174: RBAC na base de conhecimento da IA
--
-- ai_knowledge_sources e ai_knowledge_versions só isolavam por organização na
-- escrita (policy única "_all"), sem checar papel — qualquer membro,
-- inclusive "viewer" (o mais restrito), podia alterar ou apagar o material
-- que o agente de IA usa para responder cliente, direto pela RLS.
--
-- Toda rota de mutação (app/api/v1/ai/knowledge/sources/**) já exige
-- "manager". Esta migration alinha a RLS ao mesmo piso, no mesmo padrão que
-- ai_agents/ai_agent_versions já usa: policy de SELECT aberta a qualquer
-- membro da organização, policy de escrita (ALL) exigindo
-- fn_role_at_least(organization_id, 'manager').

drop policy if exists "tenant_isolation_ai_knowledge_sources_all" on "public"."ai_knowledge_sources";

create policy "tenant_isolation_ai_knowledge_sources_select" on "public"."ai_knowledge_sources"
  for select
  using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "tenant_isolation_ai_knowledge_sources_write" on "public"."ai_knowledge_sources"
  for all
  using (
    (
      (organization_id in (select public.fn_user_org_ids()))
      and public.fn_role_at_least(organization_id, 'manager')
    )
    or public.fn_is_platform_admin()
  )
  with check (
    (
      (organization_id in (select public.fn_user_org_ids()))
      and public.fn_role_at_least(organization_id, 'manager')
    )
    or public.fn_is_platform_admin()
  );

drop policy if exists "tenant_isolation_ai_kbv_all" on "public"."ai_knowledge_versions";

create policy "tenant_isolation_ai_kbv_select" on "public"."ai_knowledge_versions"
  for select
  using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "tenant_isolation_ai_kbv_write" on "public"."ai_knowledge_versions"
  for all
  using (
    (
      (organization_id in (select public.fn_user_org_ids()))
      and public.fn_role_at_least(organization_id, 'manager')
    )
    or public.fn_is_platform_admin()
  )
  with check (
    (
      (organization_id in (select public.fn_user_org_ids()))
      and public.fn_role_at_least(organization_id, 'manager')
    )
    or public.fn_is_platform_admin()
  );
