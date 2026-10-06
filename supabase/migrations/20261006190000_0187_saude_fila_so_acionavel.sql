-- ============================================================================
-- 0187 — saúde: "fila parada" só conta evento que ALGUÉM consome
--
-- Correção do sinal entregue na 0186, pega em PRODUÇÃO no primeiro ciclo do
-- vigia: ele abriu `clinica.fila_parada` para 5 das 7 clínicas, com idades de
-- 11 a 49 dias. Alarme falso — e alarme falso é a pior falha possível num
-- painel de alerta, porque ensina a ignorar o painel inteiro.
--
-- A causa: `fila_pendente_desde` olhava `min(created_at) where status='pending'`
-- de QUALQUER tipo de evento. Mas `event_log` guarda duas famílias (doutrina da
-- issue #129, ver `tests/unit/evento-comando-tem-consumidor.test.ts`):
--
--   comando (`*_requested`) — alguém PEDIU algo. Sem consumidor, o pedido
--     nunca é atendido: atraso aqui é trabalho que não aconteceu.
--   fato (`message.outbound`, `lead.lost`, `channel_session.status_changed`…)
--     — descreve o que JÁ aconteceu. Existe para realtime/auditoria e NUNCA
--     tem consumidor; fica `pending` para sempre, por desenho.
--
-- Medido em produção: as 2.529 linhas de `message.outbound`, 1.325 de
-- `channel_session.status_changed`, 593 de `lead.lost` etc. são todas fato. O
-- "49 dias parada" era a idade do fato mais antigo — não havia trabalho
-- atrasado nenhum.
--
-- O conserto NÃO é listar os tipos aqui: quem sabe o que tem consumidor é o
-- registro de handlers em TypeScript (`getRegisteredHandlers()`), e uma cópia
-- da lista em SQL divergiria no primeiro handler novo. A função passa a RECEBER
-- os tipos acionáveis de quem a chama.
--
-- Default `'{}'`: chamada sem argumento (self-hoster no psql) não erra e não
-- inventa alarme — sem tipo acionável, não há fila a cobrar.
--
-- A assinatura muda, então é `drop` + `create` (não `create or replace`).
-- Idempotente: `drop ... if exists` da versão antiga, sem argumento.
-- ============================================================================

drop function if exists public.fn_saude_das_clinicas();

create or replace function public.fn_saude_das_clinicas(
  p_tipos_acionaveis text[] default '{}'
)
returns table (
  organization_id uuid,
  display_name text,
  slug text,
  status text,
  suspended_at timestamptz,
  canais_total int,
  canais_working int,
  agentes_publicados int,
  credenciais_ia_ativas int,
  mensagens_falhas_24h int,
  fila_pendente_desde timestamptz,
  eventos_mortos_7d int,
  avisos_abertos int,
  ultima_mensagem_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.display_name,
    o.slug::text,
    o.status,
    o.suspended_at,
    coalesce(canais.total, 0)::int,
    coalesce(canais.working, 0)::int,
    coalesce(agentes.publicados, 0)::int,
    coalesce(cred.ativas, 0)::int,
    coalesce(msgs.falhas, 0)::int,
    fila.mais_antiga,
    coalesce(mortos.total, 0)::int,
    coalesce(avisos.abertos, 0)::int,
    conv.ultima
  from public.organizations o
  left join lateral (
    select count(*) as total,
           count(*) filter (where cs.status = 'WORKING') as working
    from public.channel_sessions cs
    where cs.organization_id = o.id
  ) canais on true
  left join lateral (
    select count(*) as publicados
    from public.ai_agents a
    where a.organization_id = o.id
      and a.published_version_id is not null
  ) agentes on true
  left join lateral (
    select count(*) as ativas
    from public.ai_provider_credentials c
    where c.organization_id = o.id
      and c.is_active
      and c.validated_at is not null
  ) cred on true
  left join lateral (
    select count(*) as falhas
    from public.messages m
    where m.organization_id = o.id
      and m.status = 'failed'
      and m.created_at > now() - interval '24 hours'
  ) msgs on true
  left join lateral (
    -- SÓ tipo com consumidor: fato pendente não é trabalho atrasado.
    select min(e.created_at) as mais_antiga
    from public.event_log e
    where e.organization_id = o.id
      and e.status = 'pending'
      and e.event_type = any (p_tipos_acionaveis)
  ) fila on true
  left join lateral (
    select count(*) as total
    from public.event_log e
    where e.organization_id = o.id
      and e.status = 'dead'
      and e.created_at > now() - interval '7 days'
  ) mortos on true
  left join lateral (
    select count(*) as abertos
    from public.agent_inbox_items i
    where i.organization_id = o.id
      and i.status = 'open'
  ) avisos on true
  left join lateral (
    select max(c.last_message_at) as ultima
    from public.conversations c
    where c.organization_id = o.id
  ) conv on true
  where o.redacted_at is null
  order by o.display_name;
$$;

-- `authenticated` entra no revoke por necessidade (ver 0186): o baseline tem
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO authenticated`, e
-- esta função devolve dados de TODAS as organizações.
revoke execute on function public.fn_saude_das_clinicas(text[]) from public, anon, authenticated;
grant  execute on function public.fn_saude_das_clinicas(text[]) to service_role;

notify pgrst, 'reload schema';
