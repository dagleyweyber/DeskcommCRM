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
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('abababab-5555-4000-8000-${n}', '${org}', 'eq', 'eq') on conflict do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('abababab-5566-4000-8000-${n}', '${org}', 'abababab-5555-4000-8000-${n}', 'Novo', 'novo', 1000)
        on conflict do nothing;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
        ('abababab-6666-4000-8000-${n}', '${org}', 'abababab-5555-4000-8000-${n}', 'abababab-5566-4000-8000-${n}', 'l1', null),
        ('abababab-6666-4000-8000-1${n.slice(1)}', '${org}', 'abababab-5555-4000-8000-${n}', 'abababab-5566-4000-8000-${n}', 'l2', '${GOV_AGENT_A}'),
        ('abababab-6666-4000-8000-2${n.slice(1)}', '${org}', 'abababab-5555-4000-8000-${n}', 'abababab-5566-4000-8000-${n}', 'l3', '${GOV_AGENT_B}')
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

/** Leads que a função ANTIGA (fn_can_view_lead) liberaria, sem RLS, com as claims do usuário. */
function leadsPelaFuncaoAntiga(userId: string): number {
  const out = sql(`
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select count(*) from public.crm_leads l
     where l.organization_id in ('${ORG_ALL}', '${ORG_OWN}', '${ORG_PADRAO}')
       and public.fn_can_view_lead(l.organization_id, l.owner_user_id);
  `);
  return Number(lastLine(out));
}

const leadsPelaPolicy = (userId: string): number =>
  countAs(
    userId,
    `select count(*) from public.crm_leads
      where organization_id in ('${ORG_ALL}', '${ORG_OWN}', '${ORG_PADRAO}');`,
  );

describe("crm_leads_select — a regra não mudou (0208)", () => {
  it.each([
    ["agent A", GOV_AGENT_A],
    ["agent B", GOV_AGENT_B],
    ["manager", GOV_MANAGER],
    ["viewer", GOV_VIEWER],
    ["quem não é membro de nada", SEM_ORG],
  ])("⭐ %s vê exatamente os leads que a função antiga liberaria", (_nome, usuario) => {
    expect(leadsPelaPolicy(usuario)).toBe(leadsPelaFuncaoAntiga(usuario));
  });

  it("controle positivo: agent enxerga leads e não todos", () => {
    const n = leadsPelaPolicy(GOV_AGENT_A);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(9);
  });
});

describe("fn_conversation_counts — uma leitura, mesmos números das três antigas (0208)", () => {
  const umaLeitura = (userId: string, org: string, canal = "null") => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select unassigned || ',' || mine || ',' || total
        from public.fn_conversation_counts('${org}', ${canal}, array['closed','archived']);
    `);
    return lastLine(out).split(",").map(Number);
  };
  const tresLeituras = (userId: string, org: string) => [
    countAs(userId, `select count(*) from public.conversations where organization_id = '${org}' and assigned_to_user_id is null and status = 'open';`),
    countAs(userId, `select count(*) from public.conversations where organization_id = '${org}' and assigned_to_user_id = '${userId}' and status not in ('closed','archived');`),
    countAs(userId, `select count(*) from public.conversations where organization_id = '${org}';`),
  ];

  it.each([
    ["agent A", GOV_AGENT_A],
    ["agent B", GOV_AGENT_B],
    ["manager", GOV_MANAGER],
  ])("⭐ %s: a função única bate com as três contagens, em todos os modos", (_n, usuario) => {
    for (const org of [ORG_ALL, ORG_OWN, ORG_PADRAO]) {
      expect(umaLeitura(usuario, org)).toEqual(tresLeituras(usuario, org));
    }
  });

  it("respeita a RLS do chamador: agent em modo 'own' NÃO recebe o total da organização", () => {
    const [, , total] = umaLeitura(GOV_AGENT_A, ORG_OWN);
    expect(total).toBe(1); // só a atribuída a ele; a fila e a do colega ficam de fora
  });

  it("filtra por número quando pedido", () => {
    const [, , total] = umaLeitura(GOV_MANAGER, ORG_ALL, `'abababab-2222-4000-8000-0000000000aa'`);
    expect(total).toBe(0);
  });
});

describe("índice da aba 'Minhas'", () => {
  it("existe", () => {
    expect(indexExists("idx_conversations_org_assignee_last_msg")).toBe(true);
  });
});
