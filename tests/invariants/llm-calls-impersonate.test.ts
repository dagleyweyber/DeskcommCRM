import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, countAs, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0178 — `llm_calls` RLS ganha o fallback de platform admin.
 *
 * Achado ao vivo: a tela geral "Agente de IA › Execuções" (`/app/ai/runs`,
 * lê `llm_calls`) ficava muda no Modo Impersonate — a policy só checava
 * `fn_user_org_ids()`, e quem opera via impersonate é platform admin, nunca
 * membro de verdade da organização que está vendo (mesmo buraco da
 * `fn_conversas_ia_ativa`, corrigido na mesma migration).
 */

const IMPERSONATE_ADMIN = "cccccccc-7800-4000-8000-000000000001";
const OUTSIDER = "cccccccc-7800-4000-8000-000000000002";
const LLM_CALL = "cccccccc-7800-4000-8000-000000000003";

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${IMPERSONATE_ADMIN}', 'llm-impersonate-admin@invariant.test'),
      ('${OUTSIDER}', 'llm-outsider@invariant.test')
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${IMPERSONATE_ADMIN}', '${IMPERSONATE_ADMIN}', 'full', true, 'invariant test')
      on conflict do nothing;

    insert into public.llm_calls
      (id, organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms, status)
      values ('${LLM_CALL}', '${GOV_ORG}', 'agent_turn', 'anthropic', 'claude-sonnet-4-6', 100, 50, 10, 500, 'ok')
      on conflict do nothing;
  `);
});

describe("llm_calls — admin de plataforma sem membership (impersonate) enxerga", () => {
  it("⭐ platform admin lê a linha mesmo sem membership real em user_organizations", () => {
    expect(countAs(IMPERSONATE_ADMIN, `select count(*) from public.llm_calls where id = '${LLM_CALL}';`)).toBe(1);
  });

  it("CONTROLE: gente comum sem acesso continua barrada", () => {
    expect(countAs(OUTSIDER, `select count(*) from public.llm_calls where id = '${LLM_CALL}';`)).toBe(0);
  });
});
