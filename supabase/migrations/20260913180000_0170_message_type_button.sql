-- 0170 — `button` vira um tipo de mensagem de primeira classe.
--
-- Achado ao vivo (RevitaFio Mossoró): cliente clica num botão de resposta
-- rápida de um template ("Confirmo presença"/"Preciso remarcar") e a Meta
-- entrega certinho no webhook (`change.field = "messages"`,
-- `raw.type = "button"`) — mas o INSERT em `messages` reprovava no
-- `messages_type_check` (0091), porque `button` nunca entrou na lista.
-- `[meta.ingest] inbound não ingerido` engolia o erro e devolvia 200 pra
-- Meta (não é payload malformado, é tipo não coberto) — ela não re-entrega,
-- então a resposta do cliente se perdia pra sempre: não aparecia no inbox,
-- não abria a janela de 24h (`fn_mark_conversation_message` nunca rodava),
-- e nenhum efeito de pós-entrada disparava (`aplicarEfeitosPosEntrada`).
-- Isto vale pra QUALQUER template com botão de resposta rápida — Campanhas
-- e as automações (0169) incluídas —, não só o caso que expôs o bug.
--
-- Mesmo raciocínio de "por que ALTERAR o CHECK e não remover" do 0091:
-- `messages.type` é vocabulário FECHADO (quem escreve é nosso código, não
-- uma plataforma externa) — o CHECK se paga, move pro INSERT um erro que
-- apareceria no envio.
--
-- Backfill: nenhum, por construção — só acrescenta um valor ao conjunto
-- permitido, toda linha existente já satisfaz o CHECK novo.

do $$ begin
  alter table public.messages drop constraint if exists messages_type_check;
  alter table public.messages add constraint messages_type_check
    check (type = any (array[
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'location', 'contact', 'reaction', 'system', 'template',
      -- novo: resposta de botão de template (quick reply)
      'button'
    ]));
end $$;
