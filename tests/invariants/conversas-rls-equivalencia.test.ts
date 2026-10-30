import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_VIEWER,
  countAs,
  indexExists,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Migration 0207 — a policy `conversations_select` deixou de chamar
 * `fn_can_view_conversation` por linha (3,2 s para contar 3.150 conversas, o que
 * esgotava o pool do PostgREST e dava "Erro inesperado" às atendentes).
 *
 * O que este arquivo guarda é que a regra NÃO mudou: para cada usuário e cada
 * `visibility_mode`, o que a policy deixa ver é exatamente o que a função antiga
 * deixaria. A função segue no banco (outras tabelas a usam) e serve de gabarito.
 *
 * Namespace `abababab` — exclusivo deste arquivo, para não pisar nos outros
 * invariantes que rodam em paralelo.
 */
const ORG_ALL = "abababab-0000-4000-8000-000000000001";
const ORG_OWN = "abababab-0000-4000-8000-000000000002";
const ORG_PADRAO = "abababab-0000-4000-8000-000000000003";
const SEM_ORG = "abababab-1111-4000-8000-0000000000ff";

const ORGS: Array<[string, string, string]> = [
  [ORG_ALL, "eq-all", `jsonb_build_object('visibility_mode', 'all')`],
  [ORG_OWN, "eq-own", `jsonb_build_object('visibility_mode', 'own')`],
  [ORG_PADRAO, "eq-padrao", `'{}'::jsonb`],
];

beforeAll(() => {
  seedGov();
  let i = 0;
  for (const [org, slug, settings] of ORGS) {
    i += 1;
    const n = String(i).padStart(12, "0");
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name, settings)
        values ('${org}', '${slug}', '${slug}', '${slug}', ${settings}) on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${GOV_AGENT_A}', '${org}', 'agent', now()),
        ('${GOV_AGENT_B}', '${org}', 'agent', now()),
        ('${GOV_MANAGER}', '${org}', 'manager', now()),
        ('${GOV_VIEWER}', '${org}', 'viewer', now())
        on conflict do nothing;
      do $eq$ begin
        insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
          values ('abababab-2222-4000-8000-${n}', '${org}', '${slug}', '\\x00'::bytea);
      exception when unique_violation then null; end $eq$;
      insert into public.contacts (id, organization_id, display_name) values
        ('abababab-3333-4000-8000-${n}', '${org}', 'c1'),
        ('abababab-3333-4000-8000-1${n.slice(1)}', '${org}', 'c2'),
        ('abababab-3333-4000-8000-2${n.slice(1)}', '${org}', 'c3') on conflict do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id) values
        ('abababab-4444-4000-8000-${n}', '${org}', 'abababab-3333-4000-8000-${n}', 'abababab-2222-4000-8000-${n}', 'open', null),
        ('abababab-4444-4000-8000-1${n.slice(1)}', '${org}', 'abababab-3333-4000-8000-1${n.slice(1)}', 'abababab-2222-4000-8000-${n}', 'open', '${GOV_AGENT_A}'),
        ('abababab-4444-4000-8000-2${n.slice(1)}', '${org}', 'abababab-3333-4000-8000-2${n.slice(1)}', 'abababab-2222-4000-8000-${n}', 'open', '${GOV_AGENT_B}')
        on conflict do nothing;
    `);
  }
});

/** Quantas linhas a função ANTIGA liberaria — avaliada sem RLS, com as claims do usuário. */
function pelaFuncaoAntiga(userId: string): number {
  const out = sql(`
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select count(*) from public.conversations c
     where c.organization_id in ('${ORG_ALL}', '${ORG_OWN}', '${ORG_PADRAO}')
       and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id);
  `);
  return Number(lastLine(out));
}

const pelaPolicy = (userId: string): number =>
  countAs(
    userId,
    `select count(*) from public.conversations
      where organization_id in ('${ORG_ALL}', '${ORG_OWN}', '${ORG_PADRAO}');`,
  );

describe("conversations_select — a regra não mudou", () => {
  it.each([
    ["agent A", GOV_AGENT_A],
    ["agent B", GOV_AGENT_B],
    ["manager", GOV_MANAGER],
    ["viewer", GOV_VIEWER],
    ["quem não é membro de nada", SEM_ORG],
  ])("⭐ %s vê exatamente o que a função antiga liberaria", (_nome, usuario) => {
    expect(pelaPolicy(usuario)).toBe(pelaFuncaoAntiga(usuario));
  });

  it("controle positivo: o agent enxerga algo e NÃO enxerga tudo (o teste não é vazio)", () => {
    const visivel = pelaPolicy(GOV_AGENT_A);
    expect(visivel).toBeGreaterThan(0);
    expect(visivel).toBeLessThan(9); // 3 organizações × 3 conversas
  });

  it("modo 'own': agent não vê a fila sem dono nem a conversa do colega", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where organization_id = '${ORG_OWN}';`),
    ).toBe(1);
  });

  it("modo 'all': agent vê tudo da organização", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where organization_id = '${ORG_ALL}';`),
    ).toBe(3);
  });

  it("modo padrão: agent vê a fila sem dono e a própria, não a do colega", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where organization_id = '${ORG_PADRAO}';`),
    ).toBe(2);
  });
});

describe("índice da aba 'Minhas'", () => {
  it("existe", () => {
    expect(indexExists("idx_conversations_org_assignee_last_msg")).toBe(true);
  });
});
