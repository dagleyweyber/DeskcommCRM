-- 0193_saude_whatsapp_pulado — o onboarding deixa PULAR o WhatsApp de verdade.
--
-- Pedido explícito do dono do produto: o onboarding tem que permitir pular a
-- etapa do WhatsApp e configurar em outro momento. O botão "Pular por
-- enquanto" já existia e gravava `onboarding_state.whatsapp.skipped`, mas o
-- gate de conclusão (`finishOnboarding` + `lib/onboarding/prontidao.ts`)
-- recusava terminar sem canal funcionando — desfazendo o "pular" na tela final.
--
-- O conserto tem duas metades que precisam andar juntas:
--   1. o gate deixa de travar quando o WhatsApp foi pulado de propósito;
--   2. a classificação contínua de saúde (migration 0189) deixa de tratar
--      "onboarding concluído + zero canal" como CRÍTICO nesse caso — senão
--      toda clínica que fez exatamente o que o produto oferece abriria
--      incidente no vigia. Alarme falso é a pior falha de um painel de alerta.
--
-- Ambas leem o MESMO fato, e o fato mora no banco (`organizations.
-- onboarding_state`), então ele entra na saída de `fn_saude_das_clinicas()` —
-- mesma doutrina da 0186/0189: o SQL devolve FATO cru, quem decide é
-- `lib/admin/saude-das-clinicas.ts`. `patchOnboardingState` substitui o objeto
-- `whatsapp` inteiro, então conectar o WhatsApp depois apaga a marca sozinho.
--
-- Assinatura de saída muda (coluna nova no fim): `drop` + `create`, com o
-- mesmo revoke de `public, anon, authenticated` das migrations anteriores.
-- O corpo é o da 0189, só com a coluna nova.

drop function if exists public.fn_saude_das_clinicas(text[]);

create function public.fn_saude_das_clinicas(p_tipos_acionaveis text[] default '{}'::text[])
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
  ultima_mensagem_at timestamptz,
  whatsapp_pulado boolean
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
    conv.ultima,
    coalesce((o.onboarding_state -> 'whatsapp' ->> 'skipped') = 'true', false)
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
grant execute on function public.fn_saude_das_clinicas(text[]) to service_role;
