-- 0198_contato_bsuid — o contato que a Meta identifica SÓ pelo BSUID.
--
-- A Meta passou a mandar, em todo webhook, o BSUID (`user_id`: `BR.` + até 128
-- caracteres) — o identificador de cada pessoa por portfólio — e a OMITIR o telefone
-- quando a pessoa ativa o nome de usuário e não houve contato nos últimos 30 dias.
-- Medido em produção (2026-10-24): `from_user_id` / `to_user_id` já chegam nos payloads.
--
-- Hoje o CRM exige `from`/`to` para ingerir: uma mensagem sem telefone seria
-- descartada em silêncio — o pior desfecho num CRM de atendimento. Esta migration abre
-- o caminho: o contato passa a poder ser achado pelo BSUID, com ou sem telefone.
--
-- ─── Mesmo desenho da 0122 (`wa_lid`) ─────────────────────────────────────────
-- `contacts.wa_identity` é GERADA e dá precedência ao telefone. Mexer nela reabre o
-- defeito de contato duplicado que a 0027 matou. Então o BSUID ganha a SUA chave de
-- correlação, que não depende do telefone: quando a pessoa aparece primeiro só com o
-- BSUID e depois com o número (ou o contrário), é o MESMO contato.
--
-- ─── O que NÃO muda ───────────────────────────────────────────────────────────
-- O caminho por telefone (`fn_upsert_wa_contact`) segue idêntico. A função nova só é
-- chamada quando há BSUID no evento.

-- 1 · a chave de correlação (gerada, pelo mesmo motivo de `wa_identity`/`wa_lid`)
alter table public.contacts
  add column if not exists wa_bsuid text
  generated always as (nullif(source_metadata->>'wa_bsuid', '')) stored;

-- 2 · único por organização entre contatos vivos. Coluna nova: nenhum dado a deduplicar
-- antes do índice (todos nascem nulos), então o `update.sh` do clone não quebra.
create unique index if not exists uniq_contacts_org_wa_bsuid
  on public.contacts (organization_id, wa_bsuid)
  where wa_bsuid is not null and is_merged_into is null;

-- 3 · achar ou criar o contato por BSUID, vinculando ao telefone quando ele aparece
create or replace function public.fn_upsert_wa_contact_bsuid(
  p_org uuid, p_bsuid text, p_phone text, p_notify text
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id uuid;
  v_por_telefone uuid;
begin
  if p_bsuid is null or btrim(p_bsuid) = '' then
    raise exception 'fn_upsert_wa_contact_bsuid: bsuid obrigatorio';
  end if;

  -- (a) já conhecemos este BSUID
  select id into v_id
    from public.contacts
   where organization_id = p_org and wa_bsuid = p_bsuid and is_merged_into is null
   limit 1;
  if v_id is not null then
    -- Ganhou telefone? Só preenche se o contato ainda não tem E o número não é de OUTRO
    -- contato (nesse caso a unicidade da identidade quebraria o upsert).
    if p_phone is not null then
      update public.contacts c
         set phone_number = p_phone, updated_at = now()
       where c.id = v_id
         and c.phone_number is null
         and not exists (
           select 1 from public.contacts o
            where o.organization_id = p_org and o.phone_number = p_phone
              and o.is_merged_into is null and o.id <> v_id
         );
    end if;
    return v_id;
  end if;

  -- (b) não conhecemos o BSUID, mas conhecemos o telefone: é o mesmo contato — guarda o
  -- BSUID nele em vez de criar uma segunda pessoa.
  if p_phone is not null then
    select id into v_por_telefone
      from public.contacts
     where organization_id = p_org and phone_number = p_phone and is_merged_into is null
     limit 1;
    if v_por_telefone is not null then
      update public.contacts
         set source_metadata = coalesce(source_metadata, '{}'::jsonb)
                               || jsonb_build_object('wa_bsuid', p_bsuid),
             updated_at = now()
       where id = v_por_telefone;
      return v_por_telefone;
    end if;
  end if;

  -- (c) pessoa nova (com ou sem telefone)
  begin
    insert into public.contacts
      (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
    values
      (p_org, p_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
       jsonb_build_object('wa_bsuid', p_bsuid, 'notify_name', nullif(p_notify, '')),
       nullif(p_notify, ''))
    returning id into v_id;
  exception when unique_violation then
    -- Perdeu a corrida para outra inserção da mesma pessoa: devolve a que ganhou.
    select id into v_id
      from public.contacts
     where organization_id = p_org and is_merged_into is null
       and (wa_bsuid = p_bsuid or (p_phone is not null and phone_number = p_phone))
     limit 1;
  end;
  return v_id;
end;
$$;

revoke execute on function public.fn_upsert_wa_contact_bsuid(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fn_upsert_wa_contact_bsuid(uuid, text, text, text)
  to service_role;
