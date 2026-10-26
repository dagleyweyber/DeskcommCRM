import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0196: linha de `messages` com `metadata.origem = 'historico_importado'`
 * NÃO gera evento; a mesma linha sem a marca gera `message.received`.
 *
 * Os dois casos juntos são o teste: só o primeiro passaria também com um gatilho
 * quebrado que nunca emite nada (e aí a automação do usuário morreria calada).
 */
const NS = "3f1a0196-0000-4000-8000-";
const org = `${NS}000000000001`;
const sess = `${NS}000000000002`;
const contato = `${NS}000000000003`;
const conv = `${NS}000000000004`;

function eventos(externalId: string): number {
  return Number(
    sql(`select count(*) from public.event_log
          where organization_id = '${org}' and event_type = 'message.received'
            and payload->>'external_id' = '${externalId}'`),
  );
}

function inserirMensagem(externalId: string, metadata: string) {
  sql(`insert into public.messages
         (organization_id, conversation_id, channel_session_id, contact_id,
          direction, type, body, external_id, status, metadata)
       values ('${org}', '${conv}', '${sess}', '${contato}',
          'inbound', 'text', 'oi', '${externalId}', 'delivered', '${metadata}'::jsonb);`);
}

describe("0196 · histórico importado não emite evento de mensagem", () => {
  it("com a marca: nenhum evento; sem a marca: message.received como sempre", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-0196', 'inv 0196', 'inv 0196') on conflict do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'inv-0196-s', '\\x00'::bytea) on conflict do nothing;
      insert into public.contacts (id, organization_id, phone_number)
      values ('${contato}', '${org}', '+5511999990196') on conflict do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, channel, status, is_group)
      values ('${conv}', '${org}', '${contato}', '${sess}', 'whatsapp', 'open', false) on conflict do nothing;
    `);

    inserirMensagem("inv0196-historico", `{"origem":"historico_importado"}`);
    inserirMensagem("inv0196-normal", `{}`);

    expect(eventos("inv0196-historico")).toBe(0);
    expect(eventos("inv0196-normal")).toBe(1);
  });
});
