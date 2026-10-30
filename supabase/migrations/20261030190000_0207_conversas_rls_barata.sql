-- 0207 — Inbox lento: a leitura de `conversations` chamava uma função por LINHA.
--
-- Sintoma (B'Laser Parnamirim, 2026-10-30): as atendentes recebem "Erro
-- inesperado. Tente novamente." em picos; F5 resolve e o erro volta. Nos logs
-- do app: `PGRST003 — Timed out acquiring connection from connection pool`.
--
-- Causa: a policy `conversations_select` era
--     fn_can_view_conversation(organization_id, assigned_to_user_id)
-- função `security definer`, que o Postgres NÃO consegue embutir na consulta:
-- roda uma vez por linha lida e, dentro, faz 3-4 consultas (platform_admins,
-- user_organizations duas vezes, organizations). Medido com a RLS de uma
-- atendente: `select count(id)` sobre 3.150 conversas = 3,2 s. A tela do inbox
-- dispara três contagens por atualização, fora a lista; o pool do PostgREST
-- (poucas conexões) esgota e o resto da fila estoura o tempo.
--
-- Correção: mesma regra, escrita de forma que o Postgres avalie UMA vez por
-- consulta, não uma por linha:
--   - `fn_user_conv_scopes()` devolve, de uma vez, as organizações do usuário
--     com o papel e o `visibility_mode` de cada uma;
--   - a policy usa `organization_id IN (subselect)` — subselect sem referência à
--     linha vira um conjunto avaliado uma vez.
--
-- A regra NÃO muda (espelha, caso a caso, `fn_can_view_conversation`):
--   admin de plataforma ............................... vê tudo
--   não é membro da organização ....................... não vê
--   viewer/manager/admin .............................. vê tudo da organização
--   conversa atribuída a mim .......................... vê
--   visibility_mode 'all' ............................. vê tudo da organização
--   visibility_mode 'own_and_unassigned' (ou ausente) . vê a fila sem dono
--   qualquer outro valor (ex.: 'own') ................. só as minhas
-- `fn_can_view_conversation` continua existindo (outras tabelas a usam).
--
-- Índice: a aba "Minhas" filtra por responsável e ordena por última mensagem;
-- sem índice que sirva os dois, o Postgres varria a organização inteira (media
-- de 534 ms em 38 mil chamadas).

create or replace function public.fn_user_conv_scopes()
returns table (organization_id uuid, role text, visibility text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select uo.organization_id,
         uo.role,
         coalesce(o.settings->>'visibility_mode', 'own_and_unassigned')
    from public.user_organizations uo
    join public.organizations o on o.id = uo.organization_id
   where uo.user_id = auth.uid()
     and uo.revoked_at is null;
$$;

revoke execute on function public.fn_user_conv_scopes() from public, anon;
grant  execute on function public.fn_user_conv_scopes() to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
      select s.organization_id from public.fn_user_conv_scopes() s
       where s.role in ('viewer', 'manager', 'admin') or s.visibility = 'all'
    )
    or (
      assigned_to_user_id = (select auth.uid())
      and organization_id in (select s.organization_id from public.fn_user_conv_scopes() s)
    )
    or (
      assigned_to_user_id is null
      and organization_id in (
        select s.organization_id from public.fn_user_conv_scopes() s
         where s.visibility = 'own_and_unassigned'
      )
    )
  );

create index if not exists idx_conversations_org_assignee_last_msg
  on public.conversations (organization_id, assigned_to_user_id, last_message_at desc nulls last)
  where assigned_to_user_id is not null;

notify pgrst, 'reload schema';
