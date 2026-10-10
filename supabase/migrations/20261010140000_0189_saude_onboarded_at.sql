-- ============================================================================
-- 0189 — fn_saude_das_clinicas ganha onboarded_at: fecha a cegueira do vigia
-- pra clínica já ATIVA sem nenhum canal
--
-- ## A lacuna, achada revisando o item 4 (provisionamento automatizado)
--
-- `classificaCanal` (lib/admin/saude-das-clinicas.ts) trata `canais_total = 0`
-- como "atenção" — correto para uma clínica que ainda está sendo configurada
-- (nunca é alarme abrir incidente crítico pra quem nem terminou o cadastro).
-- Mas o MESMO "atenção" se aplica a uma clínica que já terminou o onboarding
-- há MESES e, por qualquer motivo, ficou sem canal — e esse caso é
-- operacionalmente idêntico a "canal conectado e caiu" (hoje crítico). O vigia
-- (`vigia-da-saude.ts`) só abre incidente em crítico, então esse estado nunca
-- vira alerta: uma clínica pode estar "ao vivo" e muda no WhatsApp pra sempre,
-- em silêncio.
--
-- O fato que falta pra distinguir os dois casos já existe na própria linha —
-- `organizations.onboarded_at`. Esta migration só o ACRESCENTA à saída da
-- função (fato, não julgamento — doutrina da 0186); quem decide o que ele
-- significa continua sendo `classificaCanal`, em TypeScript, testado.
--
-- Assinatura muda (nova coluna de saída) — drop + create, mesmo padrão da
-- 0187.
-- ============================================================================

drop function if exists public.fn_saude_das_clinicas(text[]);

create or replace function public.fn_saude_das_clinicas(
  p_tipos_acionaveis text[] default '{}'
)
returns table (
  organization_id uuid,
  display_name text,
  slug text,
  status text,
  suspended_at timestamptz,
  onboarded_at timestamptz,
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
    o.onboarded_at,
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

revoke execute on function public.fn_saude_das_clinicas(text[]) from public, anon, authenticated;
grant  execute on function public.fn_saude_das_clinicas(text[]) to service_role;

notify pgrst, 'reload schema';
