-- ============================================================================
-- 0184 — índice de suporte pra retenção de event_log
--
-- Parte 2 do mesmo achado da 0183 (lentidão relatada pela RevitaFio Mossoró):
-- `event_log` nunca teve NENHUMA limpeza — nem das linhas que terminam
-- corretamente (`done`/`dead`). Com mais clínicas entrando, essa tabela só
-- cresce, sem teto, pressionando Disk IO pra sempre (achado ao vivo no mesmo
-- incidente: painel do Supabase mostrou Compute/Disk IO em 100%).
--
-- Esta migration só prepara o terreno pro worker de retenção
-- (`lib/event-log/retention.ts` + `api/v1/cron/event-log-retention`, mesmo
-- commit): sem este índice, o DELETE em lote varreria a tabela inteira a cada
-- execução pra achar o que já pode sair — exatamente o tipo de IO
-- desnecessário que causou o incidente que motivou esta correção. Parcial (só
-- `done`/`dead`, nunca `pending`/`processing` — não tem razão de indexar
-- idade de linha que ainda é trabalho) e por `updated_at` (quando o status
-- virou terminal, não quando a linha nasceu — é essa idade que decide
-- elegibilidade pra retenção).
--
-- Tabela pequena hoje (~55 mil linhas) — `create index` direto (sem
-- `concurrently`, que o runner de migration deste projeto não suporta dentro
-- de transação) é seguro e rápido neste tamanho.
-- ============================================================================

create index if not exists event_log_retention_idx
  on public.event_log (updated_at)
  where status in ('done', 'dead');
