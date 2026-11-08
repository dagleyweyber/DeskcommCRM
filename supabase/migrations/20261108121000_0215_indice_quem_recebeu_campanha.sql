-- 0215 — índice para "não enviar para quem recebeu campanha nos últimos N dias".
--
-- A criação de campanha passa a perguntar quem da organização recebeu campanha
-- desde uma data (`lib/campaigns/regras-de-envio.ts`). O único índice de
-- `whatsapp_campaign_recipients` era (campaign_id, status), que não serve a uma
-- consulta por organização e data: ela varreria a tabela inteira, que cresce
-- com cada disparo. Parcial em `status = 'sent'` porque é só essa que a
-- consulta lê. Idempotente.
create index if not exists whatsapp_campaign_recipients_org_sent_idx
  on public.whatsapp_campaign_recipients (organization_id, sent_at)
  where status = 'sent';
