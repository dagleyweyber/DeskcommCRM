-- 0176: devolução automática de conversa esquecida com humano
--
-- Achado auditando o CHANGELOG do fornecedor: eles mediram, numa instalação
-- real, 12 de 31 conversas ativas num dia paradas com um humano que assumiu
-- e nunca devolveu — o cliente escrevendo de novo sem resposta nenhuma.
-- `lib/escalacao/retomada.ts` (devolverAtendimentoAoAgente) já resolve a
-- devolução em si, sem furo (foi corrigida antes, nesta mesma base). Faltava
-- só o GATILHO automático por prazo — hoje só existe o botão manual.
--
-- fn_conversas_para_devolver_ao_agente resolve "quem está devida" via SQL:
-- conversas com assignee_kind='user', numa organização que ligou o prazo
-- (organizations.settings.routing.human_handoff_timeout_minutes > 0), cujo
-- ÚLTIMO SINAL da equipe (o maior entre assigned_at e a mensagem outbound
-- mais recente com sent_via em ('user','external_device')) já passou do
-- prazo — e só onde existe agente publicado pro canal daquela conversa
-- (mesma exigência que a doutrina do "dono único da resposta", #129).

create or replace function public.fn_conversas_para_devolver_ao_agente()
returns table(conversation_id uuid, organization_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with orgs_com_prazo as (
    select o.id as organization_id,
           ((o.settings #>> '{routing,human_handoff_timeout_minutes}')::int) as prazo_minutos
    from public.organizations o
    where (o.settings #>> '{routing,human_handoff_timeout_minutes}') is not null
      and ((o.settings #>> '{routing,human_handoff_timeout_minutes}')::int) > 0
  ),
  candidatas as (
    select c.id as conversation_id, c.organization_id, c.channel_session_id,
           c.assigned_at, p.prazo_minutos
    from public.conversations c
    join orgs_com_prazo p on p.organization_id = c.organization_id
    where c.assignee_kind = 'user'
      and c.status not in ('closed', 'archived')
      and c.assigned_at is not null
  ),
  ultimo_sinal as (
    select cd.conversation_id, cd.organization_id, cd.channel_session_id, cd.prazo_minutos,
           greatest(
             cd.assigned_at,
             coalesce(
               (select max(m.created_at) from public.messages m
                 where m.organization_id = cd.organization_id
                   and m.conversation_id = cd.conversation_id
                   and m.direction = 'outbound'
                   and m.sent_via in ('user', 'external_device')),
               cd.assigned_at
             )
           ) as sinal_em
    from candidatas cd
  )
  select us.conversation_id, us.organization_id
  from ultimo_sinal us
  where us.sinal_em <= now() - (us.prazo_minutos || ' minutes')::interval
    -- Só devolve onde existe agente publicado e ativo pro canal desta
    -- conversa — devolver pra ninguém deixaria a conversa muda.
    and exists (
      select 1
      from public.ai_agents a
      join public.ai_agent_versions v on v.id = a.published_version_id
      where a.organization_id = us.organization_id
        and a.is_active = true
        and a.archived_at is null
        and v.channel_session_id = us.channel_session_id
    );
$$;

revoke execute on function public.fn_conversas_para_devolver_ao_agente() from public, anon;
grant execute on function public.fn_conversas_para_devolver_ao_agente() to service_role;
