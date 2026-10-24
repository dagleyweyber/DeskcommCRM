-- 0196_historico_importado_nao_emite_evento — o gatilho de mensagem pula o histórico.
--
-- Fase 2 do Embedded Signup / Coexistência. Quando o cliente conecta o número que já
-- usa no app WhatsApp Business, a Meta entrega até ~6 meses de conversa. Cada linha
-- inserida em `messages` dispara `trg_messages_emit_event`, que emite
-- `message.received` — e os consumidores desse evento (classificação de sentimento,
-- que é CHAMADA PAGA; automações configuradas pelo usuário; follow-up; agente de IA)
-- tratariam o passado como mensagem nova: respostas automáticas a clientes de meses
-- atrás e conta de IA por milhares de mensagens.
--
-- O histórico entra com `metadata.origem = 'historico_importado'` (constante
-- ORIGEM_HISTORICO em lib/channels/meta/coexistence-ingest.ts) e o gatilho passa a
-- ignorar essas linhas. Todo o resto do corpo é idêntico ao da 0152 — mesmo payload,
-- mesmos tipos de evento. Linha SEM a marca segue emitindo como sempre.
--
-- `create or replace` preserva os grants e o vínculo do gatilho; nenhuma tabela muda.

create or replace function public.fn_emit_message_event() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_event text;
begin
  -- Linha importada do histórico da coexistência: é PASSADO, não evento. Os
  -- consumidores de `message.received` (sentimento pago, automações do usuário,
  -- follow-up, agente) tratariam seis meses de conversa como mensagem nova.
  if new.metadata ->> 'origem' = 'historico_importado' then
    return new;
  end if;

  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', left(new.body, 280)
    )
  );
  return new;
end$$;
