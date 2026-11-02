-- 0209 — Botões (e rodapé/cabeçalho) das mensagens de modelo JÁ enviadas.
--
-- Achado ao vivo (B'Laser Parnamirim, 2026-11-02): campanhas e confirmações de
-- agendamento saíam com botões ("Confirmar" / "Preciso reagendar"), e o inbox
-- mostrava só o corpo — `messages.body` guarda o corpo; os botões viviam apenas
-- em `meta_templates.components`. A equipe recebia a resposta "Confirmar" sem
-- saber quais opções o cliente tinha.
--
-- Daqui pra frente o envio (`sendMessageHandler`) grava o retrato em
-- `messages.metadata.template`, com as variáveis preenchidas pelos valores que
-- foram de fato enviados (`lib/messaging/retrato-do-modelo.ts`). Esta migration
-- faz o mesmo para o HISTÓRICO, a partir da definição espelhada hoje.
--
-- Diferenças deliberadas em relação ao retrato gravado no envio — os valores
-- enviados não foram guardados, então nada aqui inventa:
--   - cabeçalho de texto COM variável fica de fora (só entra o fixo);
--   - URL de botão com parte variável fica sem URL (o texto do botão entra);
--   - a chave `retroativo: true` marca que veio da definição atual, não do envio.
--
-- Só preenche quem ainda não tem retrato (`not metadata ? 'template'`) —
-- reaplicar não muda nada. Mensagem cujo modelo não está espelhado fica como
-- está. UPDATE em `messages` só dispara `trg_messages_updated_at` (os demais
-- triggers são AFTER INSERT): nenhum evento, nenhuma automação.
--
-- Definição: a da MESMA conexão; sem ela, a que não tem conexão (base anterior
-- à 0144). Uma só por mensagem (lateral + limit 1), nunca duplicando o UPDATE.

with alvo as (
  select m.id, d.components
    from public.messages m
    cross join lateral (
      select t.components
        from public.meta_templates t
       where t.organization_id = m.organization_id
         and t.name = m.template_name
         and t.language = m.template_language
         and (t.channel_session_id = m.channel_session_id or t.channel_session_id is null)
         and jsonb_typeof(t.components) = 'array'
       order by (t.channel_session_id is not null) desc
       limit 1
    ) d
   where m.type = 'template'
     and m.direction = 'outbound'
     and not (coalesce(m.metadata, '{}'::jsonb) ? 'template')
),
retrato as (
  select a.id,
    (select c->>'text'
       from jsonb_array_elements(a.components) c
      where upper(c->>'type') = 'HEADER'
        and upper(coalesce(c->>'format', 'TEXT')) = 'TEXT'
        and coalesce(c->>'text', '') <> ''
        and strpos(c->>'text', '{{') = 0
      limit 1) as header,
    (select c->>'text'
       from jsonb_array_elements(a.components) c
      where upper(c->>'type') = 'FOOTER'
        and coalesce(c->>'text', '') <> ''
      limit 1) as footer,
    coalesce((
      select jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object(
                 'type', upper(coalesce(b->>'type', '')),
                 'text', b->>'text',
                 'url', case when strpos(coalesce(b->>'url', ''), '{{') = 0 then nullif(b->>'url', '') end,
                 'phone', nullif(b->>'phone_number', '')
               ))
               order by c_ord, b_ord)
        from jsonb_array_elements(a.components) with ordinality as cs(c, c_ord)
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(c->'buttons') = 'array' then c->'buttons' else '[]'::jsonb end
        ) with ordinality as bs(b, b_ord)
       where upper(c->>'type') = 'BUTTONS'
         and coalesce(b->>'text', '') <> ''
    ), '[]'::jsonb) as buttons
  from alvo a
)
update public.messages m
   set metadata = coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object(
         'template',
         jsonb_strip_nulls(jsonb_build_object(
           'header', r.header,
           'footer', r.footer,
           'buttons', r.buttons,
           'retroativo', true
         ))
       )
  from retrato r
 where r.id = m.id
   and (r.header is not null or r.footer is not null or jsonb_array_length(r.buttons) > 0);
