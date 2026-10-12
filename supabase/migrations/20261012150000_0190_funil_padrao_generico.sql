-- 0190_funil_padrao_generico — troca o funil semeado em toda organização nova.
--
-- `fn_seed_default_pipeline_for_org` (migration 0003, corpo só no pg_dump de
-- `baseline.sql` — nunca teve apêndice próprio) semeava um funil de e-commerce
-- ("Pedidos": Carrinho abandonado → Aguardando pagamento → Pago → Em
-- separação → Enviado → Entregue → Pós-venda → Cancelado) pra TODA
-- organização nova, incluindo clínica/imobiliária/serviço — pedido explícito
-- do dono do produto: trocar pelo funil genérico de vendas que já é o padrão
-- real usado pelos tenants de atendimento (RevitaFio Mossoró o tem hoje, só
-- que herdado por rename manual em cima do funil de e-commerce — slugs e
-- vocabulário continuam de pedido por baixo; aqui nasce limpo).
--
-- `create or replace function` — idempotente, e o trigger existente
-- (`trg_seed_default_pipeline_for_org`) não precisa ser recriado: ele só
-- aponta pro nome da função.
--
-- NÃO retroage: organizações já existentes mantêm o funil que já têm (mudar
-- o funil de um tenant vivo reordenaria o Kanban dele e moveria negócios
-- abertos sem aviso — fora de escopo deste pedido, que é só o DAQUI PRA
-- FRENTE).

create or replace function "public"."fn_seed_default_pipeline_for_org"() returns "trigger"
    language "plpgsql"
    set "search_path" to 'public', 'pg_temp'
    as $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position, vocabulary)
  values (
    new.id, 'Padrão', 'padrao', true, 1000,
    jsonb_build_object(
      'lead', 'Lead', 'lead_plural', 'Leads',
      'deal', 'Negócio', 'deal_plural', 'Negócios',
      'won', 'Ganho', 'lost', 'Perdido',
      'stage', 'Etapa', 'stage_plural', 'Etapas'
    )
  )
  returning id into v_pipeline_id;

  for r in
    select * from (values
      ('Novo',                 'novo',                 false, false),
      ('Contato Realizado',    'contato_realizado',    false, false),
      ('Avaliação Agendada',   'avaliacao_agendada',   false, false),
      ('Avaliação Realizada',  'avaliacao_realizada',  false, false),
      ('Negociação',           'negociacao',           false, false),
      ('Fechou/Ganho',         'fechou_ganho',         true,  false),
      ('Perdido',              'perdido',              false, true)
    ) as t(stage_name, stage_slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;

revoke execute on function public.fn_seed_default_pipeline_for_org() from public, anon, authenticated;
grant execute on function public.fn_seed_default_pipeline_for_org() to service_role;
