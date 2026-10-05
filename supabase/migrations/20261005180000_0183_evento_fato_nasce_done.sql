-- ============================================================================
-- 0183 — eventos "fato" nascem `done`, não `pending`
--
-- Achado investigando lentidão relatada pela RevitaFio Mossoró (contas reais,
-- não suposição): `event_log` tinha 25.155 linhas `pending`, a mais antiga de
-- 17/08 — 48 dias. Quase tudo (20.071 de 25.155) eram `message.sent` e
-- `whatsapp.chat_id_not_recognized`, que por doutrina (comentário de cabeçalho
-- de `workers/media-derive-worker.handler.ts`, issue #129) são eventos "fato":
-- descrevem o que JÁ aconteceu, existem só pra realtime/auditoria/contagem via
-- `select count(*)`, e `tests/unit/evento-comando-tem-consumidor.test.ts`
-- deliberadamente NÃO exige consumidor pra eles — só pra `*_requested`.
--
-- O defeito não é "falta handler" (não deve ter mesmo). É que `emit_event()`
-- sempre insere com o default da coluna (`pending`), e `drainEventLog()` só
-- seleciona `event_type in (tipos com handler registrado)` — então uma linha
-- "fato" nunca é reclamada por ninguém e fica `pending` PARA SEMPRE. Com 48
-- dias de acúmulo (tipicamente mensagem enviada, altíssimo volume), o SELECT
-- do drain — que escaneia `status='pending'` globalmente, ordenado por
-- `created_at`, e o índice parcial `event_log_pending_idx` é por
-- (organization_id, created_at), não serve pra ordenação global — começou a
-- bater em `canceling statement due to statement timeout`, atrasando o
-- processamento real (status de mensagem, troca de etapa, sinais Meta Ads,
-- follow-up) de TODAS as organizações.
--
-- Fix, no único chokepoint de emissão (RPC chamado direto por TS E pelo
-- trigger `fn_emit_message_event` via `fn_log_event`, que delega a esta
-- função — mudar aqui cobre as duas origens de uma vez): os 2 tipos "fato"
-- sem consumidor conhecido nascem `done` — nunca haverá trabalho assíncrono
-- pra fazer com eles, então não há razão pra passarem por `pending`.
-- `event_log_status_check` já aceita `done`, sem mudança de schema.
--
-- Mesma doutrina da 0043 ("Backlog morto: duplicatas antigas do trigger nunca
-- terão consumer" — ver baseline.sql): o UPDATE abaixo limpa o acúmulo
-- existente, idempotente (filtra só `status='pending'`, seguro reaplicar).
-- ============================================================================

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
  v_status text;
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

  -- "fato" sem consumidor por doutrina (ver cabeçalho desta migration) — nasce
  -- `done` pra não inflar o backlog operacional de `pending` pra sempre.
  v_status := case
    when p_event_type in ('message.sent', 'whatsapp.chat_id_not_recognized') then 'done'
    else 'pending'
  end;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata, status)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())),
     v_status)
  returning id into v_event_id;

  return v_event_id;
end $$;

revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant  execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

-- Backlog morto: mesma classe de bug da 0043, dois tipos "fato" diferentes.
update public.event_log
  set status = 'done', updated_at = now()
  where status = 'pending'
    and event_type in ('message.sent', 'whatsapp.chat_id_not_recognized');
