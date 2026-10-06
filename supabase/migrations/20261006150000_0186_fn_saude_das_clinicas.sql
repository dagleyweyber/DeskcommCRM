-- ============================================================================
-- 0186 — fn_saude_das_clinicas(): saúde de TODAS as organizações numa consulta
--
-- Preparação para 50 clínicas. Hoje existe `/api/v1/admin/tenants/[id]/health`,
-- que responde por UMA organização com 4 consultas. Para saber qual das 50 está
-- quebrada, seria abrir 50 telas e disparar 200 consultas — na prática ninguém
-- faz isso, e o jeito real de descobrir problema continua sendo a clínica
-- ligando reclamando. Foi literalmente assim que os incidentes desta semana
-- apareceram.
--
-- Esta função devolve UMA LINHA POR ORGANIZAÇÃO com os sinais crus, numa ida só
-- ao banco. Os `left join lateral` existem para que organização sem nenhum
-- canal/agente/mensagem continue aparecendo (com zero) em vez de sumir da
-- lista — clínica que sumiu do painel é exatamente a que ninguém vai socorrer.
--
-- ─── Devolve FATO, não JULGAMENTO
--
-- Nenhuma coluna aqui diz "ok"/"crítico". Os limiares (quantas falhas viram
-- alarme, quanto atraso de fila é tolerável) moram em
-- `lib/admin/saude-das-clinicas.ts`, como função pura testada — mesmo padrão
-- que `app/api/v1/admin/tenants/[id]/health/route.ts` já usa. Classificar aqui
-- duplicaria a régua em duas linguagens, e elas divergiriam no primeiro ajuste.
--
-- ─── Custo
--
-- Cada agregado abaixo bate num índice parcial que JÁ EXISTE, nenhum inventado
-- para esta função:
--   mensagens falhas  → idx_messages_org_status_created (parcial sending/failed)
--   fila pendente     → event_log_pending_idx            (parcial pending)
--   eventos mortos    → event_log_dead_idx               (parcial dead)
--   avisos abertos    → idx_agent_inbox_items_open       (parcial open)
--   última mensagem   → idx_conversations_org_last_msg
-- As demais (canais, agentes, credenciais) são tabelas de dezenas de linhas.
-- É o oposto de "50 telas × 4 consultas": uma chamada, agregada onde o dado
-- mora. Depois do incidente de Disk IO em 100%, esse cuidado é requisito.
--
-- `redacted_at is null`: organização anonimizada por LGPD não é operação viva,
-- não entra no painel.
-- ============================================================================

create or replace function public.fn_saude_das_clinicas()
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
    -- "Utilizável" = ativa E validada. Chave cadastrada mas nunca validada é
    -- exatamente o estado que deixou duas clínicas com a IA muda por semanas.
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
    -- `min` sobre índice parcial (organization_id, created_at): primeira
    -- entrada da faixa, não varredura.
    select min(e.created_at) as mais_antiga
    from public.event_log e
    where e.organization_id = o.id
      and e.status = 'pending'
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

-- Doutrina de função nova em `public` (CLAUDE.md §9): as DUAS origens de
-- EXECUTE precisam ser revogadas. Só o client de service role chama isto — a
-- rota já exige platform admin antes de chegar aqui.
revoke execute on function public.fn_saude_das_clinicas() from public, anon;
grant  execute on function public.fn_saude_das_clinicas() to service_role;

notify pgrst, 'reload schema';
