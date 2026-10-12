-- 0191_valor_obrigatorio_no_ganho — exige valor da venda ao marcar um
-- negócio como ganho.
--
-- Pedido explícito do dono do produto. Hoje `crm_leads.value_cents` é
-- nullable e NENHUM caminho (endpoint /win, arrastar pro estágio is_won no
-- Kanban, bulk-move, a tool de IA `crm_close_demand`) valida nada — a mesma
-- lacuna que `crm_leads_lost_reason_required` (migration original) já fechou
-- pro lado da PERDA, nunca fechou pro lado do GANHO. Espelha exatamente o
-- mesmo desenho: CHECK estrutural na tabela, fonte única de verdade — quem
-- grava sem valor recebe erro na hora, não um negócio "ganho" sem número
-- nenhum sujando relatório de faturamento.
--
-- NOT VALID de propósito: existem hoje 4 negócios já ganhos (2 orgs) sem
-- valor gravado. Preencher um número agora seria INVENTAR dado financeiro —
-- pior que não ter. NOT VALID aplica a regra em toda escrita NOVA (insert ou
-- update) sem escanear/bloquear os 4 já existentes; quem tocar um desses 4
-- de novo (ex.: reatribuir dono) vai precisar preencher o valor NAQUELE
-- momento — efeito colateral aceitável, é exatamente o empurrão que faltava
-- pra essas 4 linhas serem corrigidas por quem sabe o valor real.
--
-- Valor precisa ser > 0, não só NOT NULL — venda de R$0,00 não é venda.

alter table public.crm_leads
  add constraint crm_leads_value_cents_required_won check (
    (status <> 'won'::text) or (value_cents is not null and value_cents > 0)
  ) not valid;
