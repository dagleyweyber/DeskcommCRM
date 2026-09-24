-- 0178: as duas correções da 0177 continuavam mudas no Modo Impersonate
--
-- Achado ao vivo (Dagley Weyber, impersonate como RevitaFio Mossoro): tanto
-- a aba "IA" do Inbox quanto a tela geral "Agente de IA › Execuções"
-- (/app/ai/runs) continuaram vazias mesmo depois da 0177. Causa raiz
-- diferente da 0177, e mais antiga: quem opera via impersonate é PLATFORM
-- ADMIN, não um membro de verdade em `user_organizations` da organização
-- que está vendo — e as duas fontes de dado checavam só
-- `fn_user_org_ids()`, sem o fallback `fn_is_platform_admin()` que o resto
-- do produto já usa em todo lugar (ver `fn_can_view_conversation`, é por
-- isso que a lista de conversas em si funciona no impersonate e estas duas
-- coisas não).
--
-- fn_conversas_ia_ativa (nasceu nesta sessão, 0177): falta corrigir aqui.
-- llm_calls (RLS preexistente, é o que alimenta /app/ai/runs): mesmo
-- buraco, mais antigo — nunca tinha o fallback.

create or replace function public.fn_conversas_ia_ativa(p_organization_id uuid)
returns table(conversation_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.conversations c
  where c.organization_id = p_organization_id
    and (public.fn_is_platform_admin() or p_organization_id in (select public.fn_user_org_ids()))
    and c.status not in ('closed', 'archived')
    and coalesce(c.assignee_kind, '') <> 'user'
    and (
      select m.sent_via
      from public.messages m
      where m.conversation_id = c.id
        and m.direction = 'outbound'
      order by m.sent_at desc
      limit 1
    ) = 'ai';
$$;

drop policy if exists "tenant_isolation_llm_calls_all" on "public"."llm_calls";

create policy "tenant_isolation_llm_calls_all" on "public"."llm_calls"
  for all
  using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids()))
  )
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids()))
  );
