-- 0214 — não lidas que a equipe já respondeu saem do contador.
--
-- Até aqui `unread_count_for_assignee` só subia (mensagem do cliente) e só
-- zerava quando a conversa trocava de dono; abrir a conversa não mudava nada.
-- A partir desta versão abrir zera (POST /api/v1/conversations/[id]/read), mas
-- o contador acumulado ficaria na tela no dia da atualização: na B'Laser
-- Parnamirim, 324 de 770 conversas abertas (2026-11-08), a maioria já
-- respondida.
--
-- Regra: se a última mensagem da EQUIPE é igual ou posterior à última do
-- cliente, alguém abriu e respondeu — zera. Conversa em que o cliente falou por
-- último fica como está: essa é de fato não lida.
--
-- Só dados, genérica para qualquer banco. Idempotente: a segunda passada não
-- encontra linha (o filtro exige contador > 0).
update public.conversations
   set unread_count_for_assignee = 0
 where unread_count_for_assignee > 0
   and last_outbound_at is not null
   and (last_inbound_at is null or last_outbound_at >= last_inbound_at);
