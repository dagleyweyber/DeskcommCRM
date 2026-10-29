-- 0204 — Funil de entrada por número conectado.
--
-- Até aqui todo lead nascia no funil padrão da organização (`crm_pipelines.is_default`),
-- qualquer que fosse o número por onde a conversa entrou. Organizações com mais de um
-- número (ex.: um para cada serviço) não conseguiam separar os contatos por funil.
--
-- A coluna é OPCIONAL: NULL = usa o funil padrão, como sempre. Nenhum número existente
-- muda de comportamento. Se o funil escolhido for apagado, volta a NULL (on delete set null);
-- se for só arquivado, a regra de entrada ignora a escolha e cai no padrão
-- (`lib/leads/nascimento-do-lead.ts`).
--
-- DIRC: é ponteiro (FK), não cópia do nome do funil. A pertença à mesma organização é
-- validada pela API ao gravar e de novo na leitura — a FK sozinha só garante que o funil existe.

alter table public.channel_sessions
  add column if not exists entry_pipeline_id uuid
    references public.crm_pipelines(id) on delete set null;

comment on column public.channel_sessions.entry_pipeline_id is
  'Funil onde nascem os leads das conversas que entram por este número. NULL = funil padrão da organização.';

notify pgrst, 'reload schema';
