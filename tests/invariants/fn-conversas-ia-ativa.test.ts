import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, GOV_VIEWER, seedGov, sql } from "./gov-helpers";

// Migration 0178: quem opera via impersonate é PLATFORM ADMIN, nunca membro
// de verdade em `user_organizations` do tenant que está vendo (mesmo padrão
// de `impersonate-bypass-completo.test.ts`).
const IMPERSONATE_ADMIN = "cccccccc-7799-4000-8000-000000000001";
const OUTSIDER = "cccccccc-7799-4000-8000-000000000002";

// Contatos PRÓPRIOS deste arquivo, não os `GOV_CONTACT_*` compartilhados —
// esses já têm conversa 1:1 criada por outros harnesses (unique
// `(organization_id, contact_id, channel_session_id)`, migration 0027), e um
// segundo `insert` pra mesma dupla silenciaria em "on conflict do nothing"
// sem criar a conversa que este arquivo espera.
const CONTATO_ULTIMA_IA = "cccccccc-7788-4000-8000-000000000001";
const CONTATO_HUMANO_RETOMOU = "cccccccc-7788-4000-8000-000000000002";
const CONTATO_FECHADA = "cccccccc-7788-4000-8000-000000000003";

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

  // `auth.users` numa chamada própria: `platform_admins.granted_by` tem FK
  // pra lá, e uma corrida foi observada ao vivo misturando os dois no MESMO
  // script — separar garante que o INSERT de baixo só roda depois do de
  // cima ter comprometido.
  sql(`
    insert into auth.users (id, email) values
      ('${IMPERSONATE_ADMIN}', 'impersonate-admin@invariant.test'),
      ('${OUTSIDER}', 'outsider@invariant.test')
      on conflict do nothing;
  `);

  sql(`
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${IMPERSONATE_ADMIN}', '${IMPERSONATE_ADMIN}', 'full', true, 'invariant test')
      on conflict do nothing;

    insert into public.contacts (id, organization_id)
      values
        ('${CONTATO_ULTIMA_IA}', '${GOV_ORG}'),
        ('${CONTATO_HUMANO_RETOMOU}', '${GOV_ORG}'),
        ('${CONTATO_FECHADA}', '${GOV_ORG}')
      on conflict do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values
        ('${CONV_ULTIMA_IA}', '${GOV_ORG}', '${CONTATO_ULTIMA_IA}', '${GOV_SESSION}', 'open'),
        ('${CONV_HUMANO_RETOMOU}', '${GOV_ORG}', '${CONTATO_HUMANO_RETOMOU}', '${GOV_SESSION}', 'open'),
        ('${CONV_FECHADA}', '${GOV_ORG}', '${CONTATO_FECHADA}', '${GOV_SESSION}', 'closed')
      on conflict do nothing;

    -- CONV_ULTIMA_IA: última outbound é da IA. Devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values
        ('${GOV_ORG}', '${CONV_ULTIMA_IA}', '${GOV_SESSION}', '${CONTATO_ULTIMA_IA}', 'text', 'inbound', 'received', 'crm', now() - interval '10 minutes'),
        ('${GOV_ORG}', '${CONV_ULTIMA_IA}', '${GOV_SESSION}', '${CONTATO_ULTIMA_IA}', 'text', 'outbound', 'sent', 'ai', now() - interval '9 minutes');

    -- CONV_HUMANO_RETOMOU: a IA respondeu primeiro, mas o atendente assumiu
    -- e respondeu DEPOIS — a ÚLTIMA outbound é humana. Não devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${CONTATO_HUMANO_RETOMOU}', 'text', 'inbound', 'received', 'crm', now() - interval '20 minutes'),
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${CONTATO_HUMANO_RETOMOU}', 'text', 'outbound', 'sent', 'ai', now() - interval '19 minutes'),
        ('${GOV_ORG}', '${CONV_HUMANO_RETOMOU}', '${GOV_SESSION}', '${CONTATO_HUMANO_RETOMOU}', 'text', 'outbound', 'sent', 'user', now() - interval '5 minutes');

    -- CONV_FECHADA: última outbound é da IA, mas a conversa está fechada. Não devida.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
      values ('${GOV_ORG}', '${CONV_FECHADA}', '${GOV_SESSION}', '${CONTATO_FECHADA}', 'text', 'outbound', 'sent', 'ai', now() - interval '1 minutes');
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

  it("⭐ admin de plataforma sem membership (impersonate) enxerga do mesmo jeito", () => {
    // Achado ao vivo (migration 0178): Dagley Weyber, impersonando a
    // RevitaFio Mossoro, via a aba "IA" vazia mesmo com a função da 0177 já
    // no ar — ele é platform admin, nunca membro de verdade de
    // `user_organizations` da RevitaFio.
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${IMPERSONATE_ADMIN}"}', false);
      select conversation_id from public.fn_conversas_ia_ativa('${GOV_ORG}');
    `);
    const linhas = out ? out.split("\n") : [];
    expect(linhas).toContain(CONV_ULTIMA_IA);
  });

  it("CONTROLE: gente comum sem acesso continua barrada — o fix não afrouxa isolamento pra mais ninguém", () => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${OUTSIDER}"}', false);
      select conversation_id from public.fn_conversas_ia_ativa('${GOV_ORG}');
    `);
    const linhas = out ? out.split("\n") : [];
    expect(linhas).not.toContain(CONV_ULTIMA_IA);
  });

  it("⭐ isolamento entre organizações: pedir o org de outro tenant devolve vazio, não vaza", () => {
    // GOV_VIEWER não é membro de nenhuma outra organização — pedir qualquer
    // outro id tem que devolver vazio, nunca as conversas de quem pediu.
    //
    // `out.trim()` sozinho não serve: `-tA` também ecoa o "SET" do `set role`
    // e o retorno do `set_config` — ruído de duas linhas que sempre aparece,
    // vazamento ou não. O que prova ausência de vazamento é NENHUMA das
    // conversas conhecidas aparecer, mesmo linha suja no meio.
    const outroOrg = "dddddddd-0000-4000-8000-000000000099";
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', false);
      select conversation_id from public.fn_conversas_ia_ativa('${outroOrg}');
    `);
    const linhas = out ? out.split("\n") : [];
    expect(linhas).not.toContain(CONV_ULTIMA_IA);
    expect(linhas).not.toContain(CONV_HUMANO_RETOMOU);
    expect(linhas).not.toContain(CONV_FECHADA);
  });
});
