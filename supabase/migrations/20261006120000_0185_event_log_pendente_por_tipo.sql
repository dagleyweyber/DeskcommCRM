-- ============================================================================
-- 0185 — índice de pendentes POR TIPO (suporte ao rodízio por organização)
--
-- Os dois drenadores de fila buscam "pendentes de certos tipos, mais antigo
-- primeiro", sem filtrar organização (é uma fila global, servindo todas):
--
--   event_log drain  : status='pending' and event_type in (...) order by created_at
--   agent-engine     : status='pending' and event_type='ai_agent.dispatch_requested'
--                      order by created_at
--
-- Nenhum índice existente servia esse formato. `event_log_pending_idx` é
-- (organization_id, created_at) — a coluna líder é a organização, que estas
-- consultas NÃO filtram, então a ordenação global por `created_at` não se
-- apoiava nele. `event_log_org_type_idx` tem o mesmo problema de coluna líder.
--
-- Isso já era verdade antes; vira mais relevante agora porque o rodízio por
-- organização (mesmo commit) lê uma janela 4× maior para ter o que intercalar
-- entre as clínicas. Sem este índice, janela maior = leitura mais funda sem
-- apoio — exatamente o IO que o incidente de ontem (Disk IO em 100%) proíbe
-- gastar à toa. Com ele, as duas consultas viram varredura ordenada de índice,
-- e a janela maior custa quase o mesmo que a pequena.
--
-- Parcial em `status='pending'`: é a única fatia que os drenadores olham, e é
-- de longe a menor da tabela (a 0183/0184 cuidaram para que `done`/`dead` não
-- se acumulem). Índice pequeno, que cabe em cache.
-- ============================================================================

create index if not exists event_log_pendente_por_tipo_idx
  on public.event_log (event_type, created_at)
  where status = 'pending';
