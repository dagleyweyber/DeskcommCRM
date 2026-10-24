-- 0197_conversa_importada_fechada_e_reabertura — o histórico entra FECHADO e reabre
-- quando o cliente (ou a clínica) volta a falar.
--
-- Achado na primeira conexão real em coexistência (B'Laser Parnamirim): importar o
-- histórico criou 528 conversas ABERTAS e sem dono. Para a recepção a Fila foi de 60
-- para 588 conversas de meses atrás, e em clínica com roteamento por rodízio cada uma
-- seria atribuída a um atendente.
--
-- Decisão de produto (dono, 2026-10-24): o histórico é passado, então entra
-- `closed`, marcado em `conversations.metadata.origem = 'historico_importado'`
-- (constante ORIGEM_HISTORICO em lib/channels/meta/conversa-importada.ts). Conversa
-- fechada não dispara o roteamento: o gatilho de 0040 só emite para open/pending.
--
-- Fechar sem reabrir esconderia a próxima mensagem do cliente numa aba de
-- "Fechadas". Por isso a segunda função: quando chega mensagem (do cliente ou o eco
-- do celular) numa conversa que ESTÁ fechada E tem a marca, ela volta a `open` e o
-- evento de roteamento é emitido — o mesmo que o gatilho emitiria para uma conversa
-- nova, porque o gatilho só olha INSERT. Só mexe em conversa MARCADA: conversa que a
-- clínica fechou à mão não muda de comportamento. A marca sai ao reabrir, então só
-- reabre uma vez.
--
-- As duas são SECURITY DEFINER e só o service_role as executa: quem chama é o webhook.

create or replace function public.fn_upsert_wa_conversation_historica(
  p_org uuid, p_contact uuid, p_session uuid
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Já existe conversa (viva ou não): não mexe nela, só devolve o id.
  select id into v_id
    from public.conversations
   where organization_id = p_org and contact_id = p_contact
     and channel_session_id = p_session and is_group = false
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.conversations
    (organization_id, contact_id, channel_session_id, channel, status, is_group,
     unread_count_for_assignee, metadata)
  values
    (p_org, p_contact, p_session, 'whatsapp', 'closed', false, 0,
     jsonb_build_object('origem', 'historico_importado'))
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do nothing
  returning id into v_id;

  -- Perdeu a corrida para outra inserção: devolve a que ganhou.
  if v_id is null then
    select id into v_id
      from public.conversations
     where organization_id = p_org and contact_id = p_contact
       and channel_session_id = p_session and is_group = false
     limit 1;
  end if;
  return v_id;
end;
$$;

create or replace function public.fn_reabrir_conversa_importada(p_conv uuid)
returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_org uuid;
begin
  update public.conversations
     set status = 'open',
         status_changed_at = now(),
         updated_at = now(),
         metadata = metadata - 'origem'
   where id = p_conv
     and status = 'closed'
     and metadata ->> 'origem' = 'historico_importado'
  returning organization_id into v_org;

  if v_org is null then
    return false;
  end if;

  -- O gatilho de roteamento só vê INSERT; ao reabrir, a conversa volta à fila e
  -- precisa pedir atribuição como qualquer conversa nova.
  perform public.emit_event(
    'conversation.routing_requested',
    'conversation',
    p_conv,
    jsonb_build_object('conversation_id', p_conv, 'organization_id', v_org),
    '{}'::jsonb,
    v_org
  );
  return true;
end;
$$;

revoke execute on function public.fn_upsert_wa_conversation_historica(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_upsert_wa_conversation_historica(uuid, uuid, uuid)
  to service_role;

revoke execute on function public.fn_reabrir_conversa_importada(uuid)
  from public, anon, authenticated;
grant execute on function public.fn_reabrir_conversa_importada(uuid)
  to service_role;
