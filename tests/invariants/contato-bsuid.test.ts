import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0198: o contato que a Meta identifica só pelo BSUID.
 *
 * O que se prova contra o banco real é o que a recepção sente:
 *   - mensagem SEM telefone vira contato (antes era descartada);
 *   - a mesma pessoa NUNCA vira dois contatos, em nenhuma ordem de chegada
 *     (BSUID primeiro e telefone depois, ou o contrário);
 *   - o número de outro contato não é roubado;
 *   - o caminho por telefone (`fn_upsert_wa_contact`) continua igual.
 */
const NS = "3f1a0198-0000-4000-8000-";
const org = `${NS}000000000001`;

function um(q: string): string {
  return sql(q).trim();
}
function upsert(bsuid: string, phone: string | null, nome: string | null = null): string {
  const p = phone === null ? "null" : `'${phone}'`;
  const n = nome === null ? "null" : `'${nome}'`;
  return um(`select public.fn_upsert_wa_contact_bsuid('${org}', '${bsuid}', ${p}, ${n})`);
}
function contagem(filtro: string): number {
  return Number(um(`select count(*) from public.contacts where organization_id='${org}' and ${filtro}`));
}

describe("0198 · contato por BSUID", () => {
  it("prepara a organização", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-0198', 'inv 0198', 'inv 0198') on conflict do nothing;
    `);
    expect(um(`select count(*) from public.organizations where id='${org}'`)).toBe("1");
  });

  it("⭐ BSUID sem telefone cria o contato (a mensagem NÃO é descartada), e é idempotente", () => {
    const a = upsert("BR.1001", null, "Ana");
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(um(`select coalesce(phone_number, 'sem-telefone') || '|' || wa_bsuid || '|' || coalesce(display_name,'') from public.contacts where id='${a}'`)).toBe(
      "sem-telefone|BR.1001|Ana",
    );
    // mesma pessoa de novo ⇒ mesmo contato, nenhuma duplicata
    expect(upsert("BR.1001", null, "Ana")).toBe(a);
    expect(contagem(`wa_bsuid = 'BR.1001'`)).toBe(1);
  });

  it("⭐ o telefone chega DEPOIS: o contato sem telefone ganha o número (mesma pessoa)", () => {
    const a = upsert("BR.1002", null);
    expect(upsert("BR.1002", "+5581999900002")).toBe(a);
    expect(um(`select phone_number from public.contacts where id='${a}'`)).toBe("+5581999900002");
    expect(contagem(`phone_number = '+5581999900002'`)).toBe(1);
  });

  it("⭐ o telefone já era conhecido: o BSUID é VINCULADO ao contato existente, sem criar outro", () => {
    sql(`select public.fn_upsert_wa_contact('${org}', 'phone', '+5581999900003', null, '5581999900003', 'Bia')`);
    const existente = um(`select id from public.contacts where organization_id='${org}' and phone_number='+5581999900003'`);

    expect(upsert("BR.1003", "+5581999900003")).toBe(existente);
    expect(um(`select wa_bsuid from public.contacts where id='${existente}'`)).toBe("BR.1003");
    expect(contagem(`phone_number = '+5581999900003'`)).toBe(1);

    // e agora o BSUID sozinho encontra a mesma pessoa
    expect(upsert("BR.1003", null)).toBe(existente);
  });

  it("⭐ nunca rouba o número de OUTRO contato", () => {
    const a = upsert("BR.1004", null); // sem telefone
    sql(`select public.fn_upsert_wa_contact('${org}', 'phone', '+5581999900004', null, '5581999900004', 'Caio')`);
    const dono = um(`select id from public.contacts where organization_id='${org}' and phone_number='+5581999900004'`);

    // o BSUID 1004 passa a vir com o número do Caio: o contato do Caio mantém o número
    expect(upsert("BR.1004", "+5581999900004")).toBe(a);
    expect(um(`select coalesce(phone_number,'sem-telefone') from public.contacts where id='${a}'`)).toBe("sem-telefone");
    expect(um(`select phone_number from public.contacts where id='${dono}'`)).toBe("+5581999900004");
  });

  it("BSUIDs diferentes são pessoas diferentes", () => {
    expect(upsert("BR.1005", null)).not.toBe(upsert("BR.1006", null));
  });

  it("o caminho por telefone segue igual: não cria wa_bsuid", () => {
    const id = um(`select public.fn_upsert_wa_contact('${org}', 'phone', '+5581999900007', null, '5581999900007', 'Dani')`);
    expect(um(`select coalesce(wa_bsuid, 'nulo') from public.contacts where id='${id}'`)).toBe("nulo");
  });

  it("bsuid vazio é recusado (não cria contato fantasma)", () => {
    let erro = "";
    try {
      sql(`select public.fn_upsert_wa_contact_bsuid('${org}', '  ', null, null)`);
    } catch (e) {
      erro = String((e as { stderr?: Buffer | string }).stderr ?? "");
    }
    expect(erro).toMatch(/bsuid obrigatorio/);
  });

  it("a função NÃO é executável por anon/authenticated (só o service_role)", () => {
    expect(
      um(`select count(*) from pg_proc p where p.proname = 'fn_upsert_wa_contact_bsuid'
            and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`),
    ).toBe("0");
  });
});
