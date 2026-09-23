import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_2, GOV_CONTACT_3, GOV_CONTACT_PROBE, GOV_ORG, GOV_SESSION, GOV_VIEWER, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0177 — `fn_conversas_ia_ativa`.
 *
 * Achado ao vivo (RevitaFio Mossoro, agente "Mariana" ativo): a aba "IA" do
 * Inbox sempre mostrava zero. `status='ai_handling'` é valor legado que
 * nada escreve mais; `assignee_kind='ai'` sozinho também não basta — o
 * motor real (lib/agent-engine) nunca toca essa coluna. A função resolve
 * pela ÚLTIMA mensagem outbound de cada conversa, não por um campo de
 * estado.
 */

const CONV_ULTIMA_IA = "cccccccc-7777-4000-8000-000000000001";
const CONV_HUMANO_RETOMOU = "cccccccc-7777-4000-8000-000000000002";
const CONV_FECHADA = "cccccccc-7777-4000-8000-000000000003";
const CONV_RECLAMADA = "cccccccc-7777-4000-8000-000000000004";

function ativas(): string[] {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', false);
    select conversation_id from public.fn_conversas_ia_ativa('${GOV_ORG}');
  `);
  return out ? out.split("\n") : [];
}

beforeAll(() => {
  seedGov();

  sql(`
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values
        ('${CONV_ULTIMA_IA}', '${GOV_ORG}', '${GOV_CONTACT_2}', '${GOV_SESSION}', 'open'),
        ('${CONV_HUMANO_RETOMOU}', '${GOV_ORG}', '${GOV_CONTACT_3}', '${GOV_SESSION}', 'open'),
        ('${CONV_FECHADA}', '${GOV_ORG}', '${GOV_CONTACT_PROBE}', '${GOV_SESSION}', 'closed')
      on conflict do nothing;

    -- CONV_ULTIMA_IA: última outbound é da IA. Devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values
        ('${GOV_ORG}', '${CONV_ULTIMA_IA}', '${GOV_SESSION}', '${GOV_CONTACT_2}', 'text', 'inbound', 'received', 'crm', now() - interval '10 minutes'),
        ('${GOV_ORG}', '${CONV_ULTIMA_IA}', '${GOV_SESSION}', '${GOV_CONTACT_2}', 'text', 'outbound', 'sent', 'ai', now() - interval '9 minutes');

    -- CONV_HUMANO_RETOMOU: a IA respondeu primeiro, mas o atendente assumiu
    -- e respondeu DEPOIS — a ÚLTIMA outbound é humana. Não devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${GOV_CONTACT_3}', 'text', 'inbound', 'received', 'crm', now() - interval '20 minutes'),
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${GOV_CONTACT_3}', 'text', 'outbound', 'sent', 'ai', now() - interval '19 minutes'),
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${GOV_CONTACT_3}', 'text', 'outbound', 'sent', 'user', now() - interval '5 minutes');

    -- CONV_FECHADA: última outbound é da IA, mas a conversa está fechada. Não devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values ('${GOV_ORG}', '${CONV_FECHADA}', '${GOV_SESSION}', '${GOV_CONTACT_PROBE}', 'text', 'outbound', 'sent', 'ai', now() - interval '1 minutes');
  `);
});

describe("fn_conversas_ia_ativa", () => {
  it("⭐ última mensagem outbound é da IA, conversa aberta — devida", () => {
    expect(ativas()).toContain(CONV_ULTIMA_IA);
  });

  it("CONTROLE: humano respondeu DEPOIS da IA — a última mensagem manda, não devida", () => {
    expect(ativas()).not.toContain(CONV_HUMANO_RETOMOU);
  });

  it("CONTROLE: conversa fechada não aparece, mesmo com última mensagem da IA", () => {
    expect(ativas()).not.toContain(CONV_FECHADA);
  });

  it("CONTROLE: função revogada de public/anon (issue #128, hardening-definer)", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_conversas_ia_ativa(uuid)', 'execute');
    `);
    expect(out.trim()).toBe("f");
  });

  it("⭐ isolamento entre organizações: pedir o org de outro tenant devolve vazio, não vaza", () => {
    // GOV_VIEWER não é membro de nenhuma outra organização — pedir qualquer
    // outro id tem que devolver vazio, nunca as conversas de quem pediu.
    const outroOrg = "dddddddd-0000-4000-8000-000000000099";
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', false);
      select conversation_id from public.fn_conversas_ia_ativa('${outroOrg}');
    `);
    expect(out.trim()).toBe("");
  });
});
