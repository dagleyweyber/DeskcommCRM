-- 0220 — envio de automação "dispensado" (skipped)
--
-- B'Laser Parnamirim, 2026-11-10: as confirmações de Laser de amanhã atrasaram
-- (ver 0219) e as atendentes confirmaram os pacientes à mão. Era preciso dizer ao
-- sistema "esta ocorrência já foi tratada, não envie" SEM mexer na agenda (status
-- do compromisso é das atendentes e do Belle) e sem fingir um envio.
--
-- Até aqui `status` só aceitava 'sent' ou 'failed': gravar a ocorrência como
-- 'failed' poluiria a contagem de falhas, e como 'sent' faria a tela e a resposta
-- do paciente acreditarem num envio que não existiu. 'skipped' é o terceiro estado:
--   - ocupa a chave única (automation_id, occurrence_key) → o despachante não envia;
--   - não tem external_id → nenhuma resposta de paciente casa com ele;
--   - não conta como enviado (`confirmacoesAguardandoResposta` filtra 'sent').
-- `sent_at` guarda o instante da dispensa; `error_message` guarda o porquê.

alter table public.whatsapp_template_automation_sends
  drop constraint if exists whatsapp_template_automation_sends_status_check;
alter table public.whatsapp_template_automation_sends
  add constraint whatsapp_template_automation_sends_status_check
  check (status in ('sent', 'failed', 'skipped'));
