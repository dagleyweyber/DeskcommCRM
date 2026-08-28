-- 0164_contato_ja_e_cliente — Fase 1: schema pra distinguir "lead novo" de
-- "contato que já é cliente", padrão Lifecycle Stage (HubSpot/Close.com).
--
-- Problema real: toda mensagem nova no WhatsApp cria um lead, mesmo quando o
-- contato já é cliente (de antes do CRM, ou por já ter comprado antes DENTRO
-- do CRM). Isso infla "quantos leads foram gerados no mês" com gente que já
-- era base, não aquisição nova.
--
-- `contacts.became_customer_at` (timestamptz, nulo até a 1ª venda/
-- reconhecimento) — UM campo, não um booleano + uma data separada: o próprio
-- valor já responde "é cliente?" (`is not null`) e "desde quando?" (LTV e
-- coorte de recompra precisam exatamente disso). Preenchido de dois jeitos
-- (fases seguintes): automático, quando um lead fecha `won` pela primeira
-- vez (Fase 2); manual, quando a comercial reconhece alguém que já é
-- cliente de antes do CRM, sem venda nenhuma registrada aqui (Fase 3 — o
-- "Marcar como cliente existente" no menu do card).
--
-- `crm_leads.status` ganha o valor `existing_customer` — MESMO slot
-- conceitual que `won`/`lost` já ocupam (um desfecho TERMINAL do card, só
-- que o motivo de fechar é "essa pessoa já era cliente", não venda nem
-- perda). Por isso entra nas DUAS constraints que já modelam esse conceito
-- (`crm_leads_status_enum` e `crm_leads_closed_at_consistency`), não numa
-- coluna nova — é o mesmo padrão que `lost` já usa.
alter table public.contacts
  add column if not exists became_customer_at timestamptz;

alter table public.crm_leads
  drop constraint if exists crm_leads_status_enum;
alter table public.crm_leads
  add constraint crm_leads_status_enum
  check (status = any (array['open', 'won', 'lost', 'existing_customer']));

alter table public.crm_leads
  drop constraint if exists crm_leads_closed_at_consistency;
alter table public.crm_leads
  add constraint crm_leads_closed_at_consistency
  check (
    (status = 'open' and closed_at is null)
    or (status = any (array['won', 'lost', 'existing_customer']) and closed_at is not null)
  );
