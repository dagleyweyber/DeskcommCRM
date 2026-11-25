-- 0225 — índices para as consultas de fundo que liam tabelas inteiras.
--
-- 2026-11-25: o CRM parou de abrir (login carregando sem fim). Causa medida no
-- pg_stat_statements: três consultas que rodam sozinhas, o tempo todo, sem índice
-- que as atendesse, liam `event_log` (360 MB) e `messages` (550 MB) do começo ao
-- fim. Somadas esgotaram o orçamento de leitura de disco (Disk IO budget) do
-- Supabase; com o disco no piso, o PostgREST enfileirou 30-120 s por pedido e a
-- tela de login não recebia resposta.
--
--   1. reaper do drain do agent-engine (lib/agent-engine/edge/crm/drain.ts),
--      a cada tick: `update event_log ... where event_type = $ and status =
--      'processing' and updated_at < ...` — 2,7 s por chamada, 6 mil chamadas;
--   2. redriveQueued (lib/agent-engine/edge/crm/session-reconciler.ts), select e
--      count de `messages where sent_via = 'ai' and status = 'queued' and
--      created_at < ...` — 6,5 s cada;
--   3. fn_ia_organizacoes_silenciosas (0175, cron ai-silence-watcher):
--      `messages where direction = 'inbound' and created_at` na última hora —
--      2,1 s.
--
-- Os três filtros selecionam uma fatia minúscula (linhas em processamento, IA na
-- fila, inbound recente), então índice PARCIAL: pequeno, barato de manter e o
-- plano vira Index Scan (medido em produção: 6,5 s -> 30 ms; 2,1 s -> 2 ms).
--
-- Sem CONCURRENTLY porque o runner envolve a migration numa transação (doutrina).
-- Em banco grande isso segura escrita na tabela enquanto o índice é construído;
-- num clone pequeno são milissegundos. Idempotente: `if not exists`.

create index if not exists idx_event_log_reaper_processing
  on public.event_log (event_type, updated_at)
  where status = 'processing';

create index if not exists idx_messages_ai_queued
  on public.messages (created_at)
  where sent_via = 'ai' and status = 'queued';

create index if not exists idx_messages_inbound_created
  on public.messages (created_at)
  where direction = 'inbound';
