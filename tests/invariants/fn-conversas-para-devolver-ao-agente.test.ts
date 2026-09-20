import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0176 — `fn_conversas_para_devolver_ao_agente`.
 *
 * Achado auditando o CHANGELOG do fornecedor: eles mediram, numa instalação
 * real, 12 de 31 conversas ativas num dia paradas com um humano que assumiu
 * e nunca devolveu. Esta função é o "quem está devida" do watcher que fecha
 * esse buraco — cada teste aqui é um par: a condição que deveria disparar a
 * devolução, e a que não deveria (senão a função "funciona" por vacuidade).
 */

const USER = "eaaa0000-0000-4000-8000-000000000001";

const ORG_DEVIDA = "eaaa1111-0000-4000-8000-000000000001";
const ORG_SINAL_RECENTE = "eaaa1111-0000-4000-8000-000000000002";
const ORG_PRAZO_DESLIGADO = "eaaa1111-0000-4000-8000-000000000003";
const ORG_SEM_AGENTE = "eaaa1111-0000-4000-8000-000000000004";
const ORG_FECHADA = "eaaa1111-0000-4000-8000-000000000005";

function ids(prefixo: string, org: string): { agent: string; version: string; session: string; contact: string; conv: string } {
  return {
    agent: `${prefixo}2222-0000-4000-8000-000000000001`,
    version: `${prefixo}3333-0000-4000-8000-000000000001`,
    session: `${prefixo}4444-0000-4000-8000-000000000001`,
    contact: `${prefixo}5555-0000-4000-8000-000000000001`,
    conv: `${prefixo}6666-0000-4000-8000-000000000001`,
  };
}

// Prefixos de 4 dígitos HEX (0-9a-f) — UUID não aceita outra coisa no
// primeiro grupo, e foi exatamente isso que quebrou aqui na primeira versão.
const D = ids("ea01", ORG_DEVIDA);
const R = ids("ea02", ORG_SINAL_RECENTE);
const P = ids("ea03", ORG_PRAZO_DESLIGADO);
const S = ids("ea04", ORG_SEM_AGENTE);
const F = ids("ea05", ORG_FECHADA);

function devidas(): string[] {
  const out = sql(`select conversation_id from public.fn_conversas_para_devolver_ao_agente();`);
  return out ? out.split("\n") : [];
}

/** Monta a organização + agente publicado (ou não) + conversa assumida por humano. */
function montarOrg(args: {
  org: string;
  ids: ReturnType<typeof ids>;
  timeoutMinutos: number | null;
  assignedMinutosAtras: number;
  publicarAgente: boolean;
  status?: string;
  ultimoSinalHumanoMinutosAtras?: number; // se ausente, sem mensagem outbound de humano
}): void {
  const { org, ids: i, timeoutMinutos, assignedMinutosAtras, publicarAgente } = args;
  const settingsJson =
    timeoutMinutos === null ? "'{}'" : `'{"routing":{"human_handoff_timeout_minutes":${timeoutMinutos}}}'`;

  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${org}', '${org.slice(0, 8)}', 'Org', 'Org', ${settingsJson}::jsonb)
      on conflict do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt, is_active) values
      ('${i.agent}', '${org}', 'Agente', 'p', true)
      on conflict do nothing;

    do $sess$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${i.session}', '${org}', '${i.session}', '\\x00'::bytea);
    exception when unique_violation then null; end $sess$;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values ('${i.version}', '${org}', '${i.agent}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${i.session}', 'published')
      on conflict do nothing;

    ${publicarAgente ? `update public.ai_agents set published_version_id = '${i.version}' where id = '${i.agent}';` : ""}

    insert into public.contacts (id, organization_id) values ('${i.contact}', '${org}')
      on conflict do nothing;

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at)
      values ('${i.conv}', '${org}', '${i.contact}', '${i.session}', '${args.status ?? "open"}', 'user', '${USER}',
              now() - interval '${assignedMinutosAtras} minutes')
      on conflict do nothing;

    ${
      args.ultimoSinalHumanoMinutosAtras !== undefined
        ? `insert into public.messages
             (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at, created_at)
           values ('${org}', '${i.conv}', '${i.session}', '${i.contact}', 'text', 'outbound', 'sent', 'user',
                   now() - interval '${args.ultimoSinalHumanoMinutosAtras} minutes',
                   now() - interval '${args.ultimoSinalHumanoMinutosAtras} minutes');`
        : ""
    }
  `);
}

beforeAll(() => {
  sql(`insert into auth.users (id, email) values ('${USER}', 'atendente@invariant.test') on conflict do nothing;`);

  // ORG_DEVIDA: prazo 10min, assumida há 30min, sem nenhum sinal depois. DEVIDA.
  montarOrg({ org: ORG_DEVIDA, ids: D, timeoutMinutos: 10, assignedMinutosAtras: 30, publicarAgente: true });

  // ORG_SINAL_RECENTE: mesmo prazo, mesma assumida há 30min, MAS respondeu há 2min. NÃO devida.
  montarOrg({
    org: ORG_SINAL_RECENTE,
    ids: R,
    timeoutMinutos: 10,
    assignedMinutosAtras: 30,
    publicarAgente: true,
    ultimoSinalHumanoMinutosAtras: 2,
  });

  // ORG_PRAZO_DESLIGADO: assumida há muito tempo, mas a org nunca ligou o prazo (settings vazio). NÃO devida.
  montarOrg({ org: ORG_PRAZO_DESLIGADO, ids: P, timeoutMinutos: null, assignedMinutosAtras: 999, publicarAgente: true });

  // ORG_SEM_AGENTE: prazo vencido, mas SEM agente publicado pro canal — devolver pra ninguém deixaria a conversa muda. NÃO devida.
  montarOrg({ org: ORG_SEM_AGENTE, ids: S, timeoutMinutos: 10, assignedMinutosAtras: 30, publicarAgente: false });

  // ORG_FECHADA: prazo vencido, agente publicado, MAS a conversa já está closed. NÃO devida.
  montarOrg({
    org: ORG_FECHADA,
    ids: F,
    timeoutMinutos: 10,
    assignedMinutosAtras: 30,
    publicarAgente: true,
    status: "closed",
  });
});

describe("fn_conversas_para_devolver_ao_agente", () => {
  it("⭐ conversa com humano, prazo vencido e sem nenhum sinal depois, aparece devida", () => {
    expect(devidas()).toContain(D.conv);
  });

  it("CONTROLE: resposta recente da equipe reseta o prazo — não aparece", () => {
    expect(devidas()).not.toContain(R.conv);
  });

  it("CONTROLE: organização sem o prazo ligado nunca devolve sozinha", () => {
    expect(devidas()).not.toContain(P.conv);
  });

  it("CONTROLE: sem agente publicado pro canal, não devolve pra ninguém", () => {
    expect(devidas()).not.toContain(S.conv);
  });

  it("CONTROLE: conversa fechada não é reaberta pelo watcher", () => {
    expect(devidas()).not.toContain(F.conv);
  });

  it("CONTROLE: função revogada de public/anon (issue #128, hardening-definer)", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_conversas_para_devolver_ao_agente()', 'execute');
    `);
    expect(out.trim()).toBe("f");
  });
});
