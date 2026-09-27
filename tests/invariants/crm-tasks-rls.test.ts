import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * RLS de `crm_tasks` (migration 0179) — duas policies, não uma `for all`
 * org-flat: leitura para qualquer membro, escrita a partir de `agent`. Um
 * `viewer` conseguindo escrever pelo PostgREST direto com o próprio JWT seria
 * a mesma falha que a 0204 já corrigiu noutra tabela.
 */

const TAREFA_A = "cccccccc-7900-4000-8000-000000000001";
const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000098";
const IMPERSONATE_ADMIN = "cccccccc-7900-4000-8000-000000000002";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.crm_tasks (id, organization_id, title, created_by)
      values ('${TAREFA_A}', '${GOV_ORG}', 'Ligar de volta na terça', '${GOV_AGENT_A}')
      on conflict do nothing;

    insert into auth.users (id, email) values
      ('${IMPERSONATE_ADMIN}', 'crm-tasks-impersonate@invariant.test')
      on conflict do nothing;
  `);
  sql(`
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${IMPERSONATE_ADMIN}', '${IMPERSONATE_ADMIN}', 'full', true, 'invariant test')
      on conflict do nothing;
  `);
});

describe("crm_tasks — RLS", () => {
  it("viewer da própria org LÊ a tarefa", () => {
    const n = countAs(
      GOV_VIEWER,
      `select count(*) from public.crm_tasks where id = '${TAREFA_A}';`,
    );
    expect(n).toBe(1);
  });

  it("viewer NÃO consegue criar tarefa — escrita exige agent", () => {
    const n = writeCountAs(
      GOV_VIEWER,
      `insert into public.crm_tasks (organization_id, title, created_by)
         values ('${GOV_ORG}', 'tarefa de viewer', '${GOV_VIEWER}')`,
    );
    expect(n).toBe(0);
  });

  it("agent consegue criar tarefa", () => {
    const n = writeCountAs(
      GOV_AGENT_A,
      `insert into public.crm_tasks (organization_id, title, created_by)
         values ('${GOV_ORG}', 'tarefa de agent', '${GOV_AGENT_A}')`,
    );
    expect(n).toBe(1);
  });

  it("isolamento entre organizações: outra org não vê nem apaga a tarefa", () => {
    const leitura = countAs(
      GOV_VIEWER,
      `select count(*) from public.crm_tasks where organization_id = '${OUTRA_ORG}';`,
    );
    expect(leitura).toBe(0);

    const escrita = writeCountAs(
      GOV_AGENT_A,
      `delete from public.crm_tasks where id = '${TAREFA_A}' and organization_id = '${OUTRA_ORG}'`,
    );
    expect(escrita).toBe(0);
  });

  it("admin de plataforma sem membership (impersonate) enxerga e escreve", () => {
    const leitura = countAs(
      IMPERSONATE_ADMIN,
      `select count(*) from public.crm_tasks where id = '${TAREFA_A}';`,
    );
    expect(leitura).toBe(1);

    const escrita = writeCountAs(
      IMPERSONATE_ADMIN,
      `update public.crm_tasks set description = 'tocado pelo admin' where id = '${TAREFA_A}'`,
    );
    expect(escrita).toBe(1);
  });

  it("função revogada de anon — a tabela não é alcançável sem sessão", () => {
    const out = sql(
      `select has_table_privilege('anon', 'public.crm_tasks', 'select');`,
    );
    expect(out.trim()).toBe("f");
  });
});
