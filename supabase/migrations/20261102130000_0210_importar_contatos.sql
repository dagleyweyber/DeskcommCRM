-- 0210 — Importação de contatos por planilha + lista de tags dos contatos.
--
-- POR QUÊ: campanhas pela API oficial para clientes da base que ainda não estão
-- no CRM (B'Laser, 2026-11-02). A campanha por tag já lê `contacts.tags`
-- (`lib/campaigns/audience.ts`), então o que falta é pôr a base no CRM com tag —
-- SEM criar lead no Kanban: importar contato não é abrir demanda.
--
-- ─── fn_importar_contatos ────────────────────────────────────────────────────
-- Uma leitura+escrita por lote (até 500 linhas), em vez de 500 idas ao banco.
-- `security invoker`: roda com o JWT de quem importa, e a RLS de `contacts`
-- (tenant_isolation_contacts_all) continua barrando outra organização mesmo que
-- `p_org` viesse errado. O papel mínimo (manager) é conferido na rota.
--
-- Regras, todas no sentido de NÃO estragar dado existente:
--   - a pessoa é achada pelo telefone em QUALQUER variante do 9º dígito
--     (`variantes`, calculadas por `phoneLookupVariants` no TypeScript) — o
--     WhatsApp grava muito celular sem o 9, e sem isto a base viraria duplicata;
--   - contato existente: tags SOMADAS (nunca trocadas); nome só preenchido se
--     vazio (ou igual ao telefone, que é o que o CRM grava sem nome); e-mail só
--     se vazio e livre; `is_blocked` NUNCA mexido — quem pediu para sair continua
--     fora de toda campanha (`audience.ts` exclui bloqueado);
--   - consentimento de marketing só é gravado onde não há registro (nem concedido,
--     nem revogado) — um "não" anterior nunca vira "sim" por importação;
--   - contato anonimizado (LGPD) é ignorado: não volta a ter dado;
--   - e-mail que já pertence a outro contato é descartado da linha (o contato
--     entra sem ele) em vez de derrubar o lote no índice único.
--
-- Nenhum evento por contato de propósito: `contact.tag_added` alimenta o motor de
-- automações e os webhooks de saída, e uma importação de 5.000 linhas viraria
-- 5.000 disparos. O registro é o audit `contacts.imported`, um por lote.

create or replace function public.fn_importar_contatos(
  p_org uuid,
  p_linhas jsonb,
  p_tags text[],
  p_consentir boolean,
  p_origem jsonb
)
returns table (linha int, resultado text, motivo text, contact_id uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_agora timestamptz := now();
  v_tags text[];
  v_variantes text[];
  v_nome text;
  v_email text;
  v_existente record;
  v_consent_marketing jsonb := jsonb_build_object(
    'granted_at', v_agora, 'source', 'import', 'version', null
  );
begin
  for r in select value from jsonb_array_elements(coalesce(p_linhas, '[]'::jsonb)) loop
    linha := (r->>'linha')::int;
    resultado := null;
    motivo := null;
    contact_id := null;

    v_variantes := array(select jsonb_array_elements_text(coalesce(r->'variantes', '[]'::jsonb)));
    v_nome := nullif(btrim(coalesce(r->>'nome', '')), '');
    v_email := nullif(btrim(coalesce(r->>'email', '')), '');
    v_tags := array(
      select distinct t
        from unnest(
          coalesce(p_tags, '{}'::text[])
          || array(select jsonb_array_elements_text(coalesce(r->'tags', '[]'::jsonb)))
        ) as t
       where btrim(t) <> ''
    );

    if r->>'telefone' is null or cardinality(v_variantes) = 0 then
      resultado := 'ignorado';
      motivo := 'telefone_invalido';
      return next;
      continue;
    end if;

    -- E-mail de outra pessoa não entra: o índice único derrubaria a linha.
    if v_email is not null and exists (
      select 1 from public.contacts c
       where c.organization_id = p_org
         and c.is_merged_into is null
         and c.email_normalized = lower(v_email)
         and not (c.phone_number = any (v_variantes))
    ) then
      v_email := null;
    end if;

    select c.id, c.is_anonymized, c.is_blocked, c.phone_number, c.name, c.display_name, c.email, c.consent
      into v_existente
      from public.contacts c
     where c.organization_id = p_org
       and c.is_merged_into is null
       and c.phone_number = any (v_variantes)
     order by (c.phone_number = r->>'telefone') desc, c.created_at
     limit 1;

    if found then
      contact_id := v_existente.id;
      if coalesce(v_existente.is_anonymized, false) then
        resultado := 'ignorado';
        motivo := 'anonimizado';
        return next;
        continue;
      end if;

      update public.contacts c
         set tags = array(select distinct t from unnest(coalesce(c.tags, '{}'::text[]) || v_tags) as t),
             display_name = case
               when nullif(btrim(coalesce(c.display_name, '')), '') is null then coalesce(v_nome, c.display_name)
               else c.display_name end,
             name = case
               when nullif(btrim(coalesce(c.name, '')), '') is null or c.name = c.phone_number then coalesce(v_nome, c.name)
               else c.name end,
             email = case when c.email is null then v_email else c.email end,
             consent = case
               when p_consentir
                and coalesce(c.consent->'marketing'->>'granted_at', '') = ''
                and coalesce(c.consent->'marketing'->>'revoked_at', '') = ''
               then coalesce(c.consent, '{}'::jsonb) || jsonb_build_object('marketing', v_consent_marketing)
               else c.consent end,
             updated_at = v_agora
       where c.id = v_existente.id;

      resultado := 'atualizado';
      -- Avisado à tela: está no CRM com a tag, mas campanha nenhuma chega nele.
      if coalesce(v_existente.is_blocked, false) then motivo := 'bloqueado'; end if;
      return next;
      continue;
    end if;

    begin
      insert into public.contacts (
        organization_id, phone_number, name, display_name, email, tags,
        source, source_metadata, consent, created_by_user_id
      ) values (
        p_org, r->>'telefone', v_nome, v_nome, v_email, v_tags,
        'import', coalesce(p_origem, '{}'::jsonb),
        case when p_consentir then jsonb_build_object('marketing', v_consent_marketing) else '{}'::jsonb end,
        auth.uid()
      )
      returning id into contact_id;
      resultado := 'criado';
    exception when unique_violation then
      -- Outra importação (ou o WhatsApp) criou o mesmo telefone no meio deste lote.
      resultado := 'ignorado';
      motivo := 'duplicado';
    end;
    return next;
  end loop;
end;
$$;

revoke execute on function public.fn_importar_contatos(uuid, jsonb, text[], boolean, jsonb) from public, anon;
grant  execute on function public.fn_importar_contatos(uuid, jsonb, text[], boolean, jsonb) to authenticated, service_role;

-- ─── fn_tags_dos_contatos ────────────────────────────────────────────────────
-- Todas as tags da organização com quantos contatos têm cada uma. Antes, o filtro
-- de Contatos montava a lista só com os 50 contatos carregados na tela — tag de
-- uma base importada não aparecia — e a campanha pedia a tag digitada à mão,
-- onde "VIP" e "vip" são públicos diferentes. `security invoker`: RLS do chamador.
create or replace function public.fn_tags_dos_contatos(p_org uuid)
returns table (tag text, total bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select t as tag, count(*) as total
    from public.contacts c
    cross join lateral unnest(c.tags) as t
   where c.organization_id = p_org
     and c.is_merged_into is null
   group by t
   order by count(*) desc, t;
$$;

revoke execute on function public.fn_tags_dos_contatos(uuid) from public, anon;
grant  execute on function public.fn_tags_dos_contatos(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
