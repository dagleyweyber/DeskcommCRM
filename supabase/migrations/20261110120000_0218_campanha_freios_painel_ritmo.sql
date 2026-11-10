-- 0218 — proteção, painel e espera programada das campanhas da API oficial.
--
-- Três pedidos do dono do produto, depois de um dia de campanhas de 2.000 contatos por loja:
--
-- 1. PARADA AUTOMÁTICA. A campanha seguia disparando quando a Meta pausava o modelo
--    (Boa Viagem: 353 contatos queimados com "modelo PAUSED"), recusava a cobrança
--    (Caruaru: 2.493 mensagens) ou quando muita gente pedia para sair. Agora a campanha
--    para sozinha e GUARDA O MOTIVO (`pausa_motivo` + `pausa_detalhe`), que a tela mostra.
--    `retomada_em` marca a volta: os freios que medem taxa (cobrança, saídas) passam a
--    olhar só o que saiu depois dela — sem isso a mesma amostra antiga pausaria de novo
--    no minuto seguinte. `freios_dispensados` guarda o que o operador aceitou ao retomar
--    (ex.: seguir com o modelo em nota amarela).
--
-- 2. PAINEL. `fn_resultado_da_campanha` conta, por campanha: aceitas, entregues, lidas,
--    respostas (até 72 h), saídas (pedido de descadastro até 72 h) e falhas por código.
--    É uma função (e não leitura na rota) porque o PostgREST corta toda leitura em 1.000
--    linhas — o mesmo defeito que já zerou o contador de uma campanha de 2.000.
--    Qualidade do número: `channel_sessions.meta_quality_*`, gravado pela checagem de
--    saúde (a cada 5 min) e pelo aviso `phone_number_quality_update`.
--
-- 3. ESPERA PROGRAMADA. `bloco_tamanho` mensagens, depois `bloco_espera_minutos` de
--    espera, e assim por diante. Os dois juntos ou nenhum. `bloco_enviados` conta o bloco
--    em andamento; `proximo_bloco_em` é quando o despachante pode voltar a mandar.
--
-- Aditiva e idempotente: campanhas existentes ficam sem motivo de pausa e sem blocos.

alter table public.whatsapp_campaigns
  add column if not exists pausa_motivo text
    check (pausa_motivo in (
      'manual',
      'cobranca_recusada',
      'modelo_nota_amarela',
      'modelo_nota_vermelha',
      'modelo_pausado',
      'modelo_desativado',
      'alerta_da_conta',
      'violacao_da_conta',
      'numero_qualidade_baixa',
      'saidas_acima_do_limite'
    )),
  add column if not exists pausa_detalhe text,
  add column if not exists pausada_em timestamptz,
  add column if not exists retomada_em timestamptz,
  add column if not exists freios_dispensados text[] not null default '{}',
  add column if not exists bloco_tamanho integer check (bloco_tamanho between 10 and 100000),
  add column if not exists bloco_espera_minutos integer check (bloco_espera_minutos between 1 and 1440),
  add column if not exists bloco_enviados integer not null default 0,
  add column if not exists proximo_bloco_em timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.whatsapp_campaigns'::regclass
       and conname = 'whatsapp_campaigns_bloco_completo'
  ) then
    alter table public.whatsapp_campaigns
      add constraint whatsapp_campaigns_bloco_completo
      check ((bloco_tamanho is null) = (bloco_espera_minutos is null));
  end if;
end $$;

-- Qualidade do número segundo a Meta. Vocabulário da Meta (GREEN/YELLOW/RED/UNKNOWN,
-- TIER_250/TIER_1K/…), sem CHECK: valor novo do lado de lá não pode quebrar a gravação.
alter table public.channel_sessions
  add column if not exists meta_quality_rating text,
  add column if not exists meta_messaging_limit text,
  add column if not exists meta_quality_event text,
  add column if not exists meta_quality_updated_at timestamptz;

-- Resultado de uma campanha. `p_desde` limita aos envios a partir de um instante (o freio
-- de saídas olha só o que saiu depois da última retomada); `null` = a campanha inteira.
-- plpgsql: no baseline a função fica antes das tabelas de campanha (varredura de anon).
create or replace function public.fn_resultado_da_campanha(
  p_org uuid,
  p_campaign uuid,
  p_desde timestamptz default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_resultado jsonb;
begin
  with env as (
    select r.status as r_status,
           r.error_message,
           r.sent_at,
           r.contact_id,
           m.status as m_status,
           m.conversation_id,
           m.metadata
      from public.whatsapp_campaign_recipients r
      left join public.messages m
        on m.organization_id = r.organization_id
       and m.external_id = r.external_id
     where r.campaign_id = p_campaign
       and r.organization_id = p_org
       and (p_desde is null or r.sent_at >= p_desde)
  ),
  marcado as (
    select e.*,
           case
             when e.r_status = 'failed' then
               coalesce(
                 substring(e.error_message from '^meta_([0-9]+)'),
                 case when e.error_message like 'template_not_approved%' then 'modelo_nao_aprovado' end,
                 'outro'
               )
             when e.r_status = 'sent' and e.m_status = 'failed' then
               coalesce(e.metadata->>'failure_code', 'outro')
           end as codigo_falha,
           (e.r_status = 'sent' and exists (
              select 1 from public.messages i
               where i.conversation_id = e.conversation_id
                 and i.direction = 'inbound'
                 and i.sent_at >= e.sent_at
                 and i.sent_at < e.sent_at + interval '72 hours'
           )) as respondeu,
           (e.r_status = 'sent' and exists (
              select 1 from public.contacts c
               where c.id = e.contact_id
                 and c.is_blocked
                 and c.blocked_reason = 'stop_keyword'
                 and c.blocked_at >= e.sent_at
                 and c.blocked_at < e.sent_at + interval '72 hours'
           )) as saiu
      from env e
  )
  select jsonb_build_object(
           'total', count(*),
           'pendentes', count(*) filter (where r_status in ('pending', 'sending')),
           'aceitas', count(*) filter (where r_status = 'sent'),
           'entregues', count(*) filter (where r_status = 'sent' and m_status in ('delivered', 'read')),
           'lidas', count(*) filter (where r_status = 'sent' and m_status = 'read'),
           'respostas', count(*) filter (where respondeu),
           'saidas', count(*) filter (where saiu),
           'falhas', count(*) filter (where codigo_falha is not null),
           'falhas_por_codigo', coalesce(
             (select jsonb_object_agg(codigo_falha, n)
                from (select codigo_falha, count(*) as n
                        from marcado
                       where codigo_falha is not null
                       group by codigo_falha) f),
             '{}'::jsonb)
         )
    into v_resultado
    from marcado;
  return v_resultado;
end;
$$;

revoke execute on function public.fn_resultado_da_campanha(uuid, uuid, timestamptz) from public, anon;
revoke execute on function public.fn_resultado_da_campanha(uuid, uuid, timestamptz) from authenticated;
grant execute on function public.fn_resultado_da_campanha(uuid, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
