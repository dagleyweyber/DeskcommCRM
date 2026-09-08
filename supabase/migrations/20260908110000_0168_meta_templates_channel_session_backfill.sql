-- 0168_meta_templates_channel_session_backfill
--
-- `meta_templates.channel_session_id` existe desde a migration 0154 ("definição
-- sabe de qual conexão é"), mas `syncTemplates` — o ÚNICO escritor desta tabela —
-- nunca foi atualizado pra preenchê-la. Toda linha sincronizada desde então (em
-- QUALQUER organização) nasceu com `channel_session_id` nulo, e qualquer leitura
-- que endereçasse "o template DESTA conexão" achava zero linha — achado ao vivo
-- pela campanha em massa (migration 0167), a primeira leitura a depender da
-- coluna: "Este modelo não está aprovado para este canal" pra um modelo que
-- estava, sim, aprovado.
--
-- Backfill genérico (não hardcoded a nenhum tenant): casa cada linha órfã com a
-- sessão da MESMA organização cuja `meta_waba_id` bate com o `waba_id` do
-- template. Idempotente — só toca linha com `channel_session_id is null`, e uma
-- reaplicação sem candidato novo não muda nada.
update public.meta_templates mt
set channel_session_id = cs.id
from public.channel_sessions cs
where mt.channel_session_id is null
  and cs.organization_id = mt.organization_id
  and cs.meta_waba_id = mt.waba_id;
