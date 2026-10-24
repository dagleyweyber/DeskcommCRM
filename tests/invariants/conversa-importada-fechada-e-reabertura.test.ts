import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0197: o histórico importado entra FECHADO e reabre quando alguém fala.
 *
 * O que se prova aqui é o comportamento que o produto promete à recepção:
 *   - conversa histórica nasce `closed`, marcada, e NÃO pede roteamento (a Fila não
 *     enche de meses de conversa, e clínica com rodízio não distribui o passado);
 *   - reabrir devolve `open`, tira a marca e pede roteamento UMA vez;
 *   - conversa que a clínica fechou à mão NÃO é reaberta;
 *   - conversa já existente não é tocada pela criação histórica.
 */
const NS = "3f1a0197-0000-4000-8000-";
const org = `${NS}000000000001`;
const sess = `${NS}000000000002`;
const contatoNovo = `${NS}000000000003`;
const contatoManual = `${NS}000000000004`;
const contatoViva = `${NS}000000000005`;

function um(q: string): string {
  return sql(q).trim();
}
function eventosRoteamento(conv: string): number {
  return Number(
    um(`select count(*) from public.event_log
         where organization_id = '${org}' and event_type = 'conversation.routing_requested'
           and payload->>'conversation_id' = '${conv}'`),
  );
}

describe("0197 · conversa importada fechada e reabertura", () => {
  it("histórico nasce fechado e marcado, sem pedir roteamento; reabrir devolve open, tira a marca e pede roteamento UMA vez", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-0197', 'inv 0197', 'inv 0197') on conflict do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'inv-0197-s', '\\x00'::bytea) on conflict do nothing;
      insert into public.contacts (id, organization_id, phone_number) values
        ('${contatoNovo}', '${org}', '+5511999970001'),
        ('${contatoManual}', '${org}', '+5511999970002'),
        ('${contatoViva}', '${org}', '+5511999970003')
      on conflict do nothing;
    `);

    const conv = um(`select public.fn_upsert_wa_conversation_historica('${org}', '${contatoNovo}', '${sess}')`);
    expect(conv).toMatch(/^[0-9a-f-]{36}$/);

    expect(um(`select status || '|' || coalesce(metadata->>'origem','') from public.conversations where id='${conv}'`)).toBe(
      "closed|historico_importado",
    );
    // ⭐ fechada ⇒ o gatilho de roteamento (só open/pending) não disparou
    expect(eventosRoteamento(conv)).toBe(0);

    // idempotente: chamar de novo devolve a MESMA conversa
    expect(um(`select public.fn_upsert_wa_conversation_historica('${org}', '${contatoNovo}', '${sess}')`)).toBe(conv);

    // reabre: open, marca removida, UM pedido de roteamento
    expect(um(`select public.fn_reabrir_conversa_importada('${conv}')`)).toBe("t");
    expect(um(`select status || '|' || coalesce(metadata->>'origem','sem-marca') from public.conversations where id='${conv}'`)).toBe(
      "open|sem-marca",
    );
    expect(eventosRoteamento(conv)).toBe(1);

    // só reabre uma vez: a marca saiu, então a segunda chamada não faz nada
    expect(um(`select public.fn_reabrir_conversa_importada('${conv}')`)).toBe("f");
    expect(eventosRoteamento(conv)).toBe(1);
  });

  it("⭐ conversa que a clínica fechou À MÃO (sem a marca) não é reaberta", () => {
    sql(`
      insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, metadata)
      values ('${org}', '${contatoManual}', '${sess}', 'whatsapp', 'closed', false, '{}'::jsonb);
    `);
    const conv = um(`select id from public.conversations where organization_id='${org}' and contact_id='${contatoManual}'`);
    expect(um(`select public.fn_reabrir_conversa_importada('${conv}')`)).toBe("f");
    expect(um(`select status from public.conversations where id='${conv}'`)).toBe("closed");
  });

  it("conversa JÁ existente e aberta não é fechada pela criação histórica", () => {
    sql(`
      insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, metadata)
      values ('${org}', '${contatoViva}', '${sess}', 'whatsapp', 'open', false, '{}'::jsonb);
    `);
    const existente = um(`select id from public.conversations where organization_id='${org}' and contact_id='${contatoViva}'`);
    expect(um(`select public.fn_upsert_wa_conversation_historica('${org}', '${contatoViva}', '${sess}')`)).toBe(existente);
    expect(um(`select status from public.conversations where id='${existente}'`)).toBe("open");
  });

  it("as duas funções NÃO são executáveis por anon/authenticated (só o service_role)", () => {
    const exposta = um(`
      select count(*) from pg_proc p
       where p.proname in ('fn_upsert_wa_conversation_historica', 'fn_reabrir_conversa_importada')
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
    expect(exposta).toBe("0");
  });
});
