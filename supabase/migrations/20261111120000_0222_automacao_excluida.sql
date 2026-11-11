-- 0222 — automação excluída (archived_at)
--
-- B'Laser Parnamirim, 2026-11-10: sobrou uma automação pausada e substituída ("Confirmação
-- Agendamento Laser") que, se reativada sem querer, mandaria 76 mensagens de uma vez — e a
-- tela não tinha como tirá-la do caminho.
--
-- "Excluir" NÃO apaga a linha. `whatsapp_template_automation_sends.automation_id` é
-- `on delete cascade`, e esses envios são duas coisas que não podem sumir:
--   1. a prova do que foi mandado e a quem (auditoria da clínica);
--   2. o elo da RESPOSTA do paciente: o botão "Confirmo" do modelo é casado com o envio por
--      `external_id` (lib/agenda/confirmacao.ts) e dali com a automação e o compromisso.
--      Apagar a automação faria as respostas das confirmações já enviadas deixarem de
--      confirmar a agenda — em silêncio.
-- Então excluir = `archived_at` preenchido (a rota também força `status = 'paused'`): some da
-- lista, não é editada nem ativada, não bloqueia a exclusão do modelo, e o despachante a
-- ignora. O histórico e as respostas continuam funcionando.
--
-- Aditiva: toda automação existente fica com `archived_at` nulo (continua como está).

alter table public.whatsapp_template_automations
  add column if not exists archived_at timestamptz;

comment on column public.whatsapp_template_automations.archived_at is
  'Excluída pelo usuário (migration 0222): some da lista e nunca envia. A linha fica para preservar o histórico de envios e o elo das respostas dos pacientes.';
