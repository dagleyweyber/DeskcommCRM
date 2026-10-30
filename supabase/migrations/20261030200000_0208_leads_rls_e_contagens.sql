-- 0208 — Mesma cura da 0207, agora no Kanban (`crm_leads`) e nas contagens do inbox.
--
-- 1) `crm_leads_select` chamava `fn_can_view_lead(organization_id, owner_user_id)`
--    por linha — a mesma função `security definer` com 3-4 consultas dentro que a
--    0207 tirou de `conversations` (a regra é idêntica, só troca "responsável"
--    por "dono do lead"). O Kanban lê muitas linhas por tela (média de 147 ms em
--    37 mil chamadas) e disputa o mesmo pool do PostgREST. Reaproveita
--    `fn_user_conv_scopes()` (papel + visibility_mode por organização do usuário).
--
--    A regra NÃO muda:
--      admin de plataforma ............................... vê tudo
--      não é membro da organização ....................... não vê
--      viewer/manager/admin .............................. vê tudo
--      lead meu .......................................... vê
--      visibility_mode 'all' ............................. vê tudo
--      visibility_mode 'own_and_unassigned' (ou ausente) . vê o lead sem dono
--      qualquer outro valor (ex.: 'own') ................. só os meus
--    As policies de UPDATE/DELETE de leads seguem como estão (escrita é por
--    linha única; o custo estava na leitura).
--
-- 2) `fn_conversation_counts`: os badges do inbox faziam TRÊS `count(*)` por
--    atualização (fila, minhas, todas), a cada 30 s por aba aberta, cada um
--    lendo a organização inteira sob RLS. Agora é UMA leitura com agregados
--    filtrados. `security invoker` (o padrão): a RLS do chamador vale, então um
--    agent em modo 'own' continua recebendo a contagem do SEU escopo, nunca o
--    total da organização.
--
--    Os estados terminais chegam POR PARÂMETRO — a fonte única continua sendo
--    `CONVERSATION_TERMINAL_STATUSES` no TypeScript, o mesmo que a aba usa; o
--    SQL não ganha uma segunda lista que pudesse divergir do badge.

drop policy if exists "crm_leads_select" on public.crm_leads;
create policy "crm_leads_select" on public.crm_leads
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
      select s.organization_id from public.fn_user_conv_scopes() s
       where s.role in ('viewer', 'manager', 'admin') or s.visibility = 'all'
    )
    or (
      owner_user_id = (select auth.uid())
      and organization_id in (select s.organization_id from public.fn_user_conv_scopes() s)
    )
    or (
      owner_user_id is null
      and organization_id in (
        select s.organization_id from public.fn_user_conv_scopes() s
         where s.visibility = 'own_and_unassigned'
      )
    )
  );

create or replace function public.fn_conversation_counts(
  p_org uuid,
  p_channel_session_id uuid,
  p_terminal_statuses text[]
)
returns table (unassigned bigint, mine bigint, total bigint)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select
    count(*) filter (where c.assigned_to_user_id is null and c.status = 'open'),
    count(*) filter (where c.assigned_to_user_id = auth.uid()
                       and not (c.status = any (p_terminal_statuses))),
    count(*)
  from public.conversations c
  where c.organization_id = p_org
    and (p_channel_session_id is null or c.channel_session_id = p_channel_session_id);
$$;

revoke execute on function public.fn_conversation_counts(uuid, uuid, text[]) from public, anon;
grant  execute on function public.fn_conversation_counts(uuid, uuid, text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
