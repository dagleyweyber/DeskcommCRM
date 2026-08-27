import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_LEAD, GOV_SESSION, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Impersonate (S-11.07) — bypass faltando em `emit_event`, `retrieve_top_k_
 * chunks`, `fn_conversation_assign` e em 7 conjuntos de política de RLS
 * (migration 0163).
 *
 * Achado ao vivo: admin de plataforma impersonando um tenant tentou trocar o
 * "Atendente" de um lead e levou "Erro interno" — o trigger de atribuição
 * chama `emit_event`, que tem gate PRÓPRIO (separado da RLS) sem bypass. O
 * admin nunca é membro real de `user_organizations` do tenant (impersonate é
 * aditivo, não cria linha lá), então `fn_role_at_least` sempre devolve false
 * pra ele — e antes desta migration, isso derrubava a chamada.
 *
 * `IMPERSONATE_ADMIN` aqui não é membro de `GOV_ORG` nenhum — é exatamente o
 * cenário que quebrava. `OUTSIDER` também não é membro e NÃO é admin de
 * plataforma — prova que gente comum sem acesso continua barrada (o fix é
 * aditivo, não afrouxa isolamento pra ninguém além do admin de plataforma).
 */
const IMPERSONATE_ADMIN = "eeeeeeee-1111-4000-8000-000000000001";
const OUTSIDER = "eeeeeeee-1111-4000-8000-000000000002";
const IB_CONTACT = "eeeeeeee-3333-4000-8000-000000000001";
const IB_CONV = "eeeeeeee-4444-4000-8000-000000000001";

function assignAs(userId: string, toUserId: string | null): { ok: true; rows: number } | { ok: false; error: string } {
  try {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select count(*) from public.fn_conversation_assign(
        '${GOV_ORG}'::uuid, '${IB_CONV}'::uuid, ${toUserId ? `'${toUserId}'::uuid` : "null::uuid"}, 'test', null::uuid, false);
    `);
    return { ok: true, rows: Number(lastLine(out)) };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    return { ok: false, error: stderr };
  }
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${IMPERSONATE_ADMIN}', 'impersonate-admin@invariant.test'),
      ('${OUTSIDER}', 'outsider@invariant.test')
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${IMPERSONATE_ADMIN}', '${IMPERSONATE_ADMIN}', 'full', true, 'invariant test')
      on conflict do nothing;

    insert into public.contacts (id, organization_id, display_name)
      values ('${IB_CONTACT}', '${GOV_ORG}', 'Impersonate Bypass Contact')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${IB_CONV}', '${GOV_ORG}', '${IB_CONTACT}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
  `);
});

describe("emit_event — admin de plataforma sem membership não é barrado", () => {
  function emitAs(userId: string): { ok: true; id: string } | { ok: false; error: string } {
    try {
      const out = sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
        select public.emit_event('impersonate.test', 'crm_lead', '${GOV_LEAD}'::uuid, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
      `);
      return { ok: true, id: lastLine(out) };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return { ok: false, error: stderr };
    }
  }

  it("⭐ admin de plataforma (não-membro) emite evento com sucesso", () => {
    const r = emitAs(IMPERSONATE_ADMIN);
    expect(r.ok).toBe(true);
  });

  it("⭐ outsider (não-membro, não admin) continua barrado — isolamento não afrouxou", () => {
    const r = emitAs(OUTSIDER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("caller_not_authorized_for_org");
  });
});

describe("fn_member_role_in_org — achada testando o fix de fn_conversation_assign", () => {
  function roleAs(callerId: string, targetId: string): string {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${callerId}"}', false);
      select coalesce(public.fn_member_role_in_org('${targetId}'::uuid, '${GOV_ORG}'::uuid), 'null');
    `);
    return lastLine(out);
  }

  it("⭐ admin de plataforma (não-membro) VÊ o papel real do destinatário", () => {
    expect(roleAs(IMPERSONATE_ADMIN, GOV_AGENT_A)).toBe("agent");
  });

  it("outsider (não-membro, não admin) continua sem ver — devolve null, não vaza membership", () => {
    expect(roleAs(OUTSIDER, GOV_AGENT_A)).toBe("null");
  });
});

describe("fn_conversation_assign — gate do CHAMADOR tem bypass, gate do DESTINATÁRIO não", () => {
  it("⭐ admin de plataforma (não-membro) atribui a um agent+ elegível com sucesso", () => {
    const r = assignAs(IMPERSONATE_ADMIN, GOV_AGENT_A);
    expect(r).toEqual({ ok: true, rows: 1 });
  });

  it("⭐ admin de plataforma atribuindo a alguém NÃO elegível ainda é recusado — bypass é só do chamador", () => {
    const r = assignAs(IMPERSONATE_ADMIN, OUTSIDER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("assignee_not_eligible_member");
  });

  it("outsider (não-membro, não admin) continua barrado no gate do chamador", () => {
    const r = assignAs(OUTSIDER, GOV_AGENT_A);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("caller_not_authorized_for_org");
  });
});

describe("retrieve_top_k_chunks — admin de plataforma não é barrado", () => {
  const EMBEDDING = `'[${Array(1536).fill("0").join(",")}]'::vector`;

  it("⭐ admin de plataforma (não-membro) consulta sem estourar (0 linhas é esperado, erro não)", () => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${IMPERSONATE_ADMIN}"}', false);
      select count(*) from public.retrieve_top_k_chunks(
        '${GOV_ORG}'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, ${EMBEDDING});
    `);
    expect(lastLine(out)).toBe("0");
  });

  it("outsider (não-membro, não admin) continua barrado", () => {
    let stderr = "";
    try {
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${OUTSIDER}"}', false);
        select count(*) from public.retrieve_top_k_chunks(
          '${GOV_ORG}'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, ${EMBEDDING});
      `);
      throw new Error("esperava exceção do banco, nenhuma foi lançada");
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? "";
    }
    expect(stderr).toContain("caller_not_authorized_for_org");
  });
});

/**
 * As 7 políticas de RLS corrigidas (migration 0163) — checagem estrutural via
 * `pg_policies`: prova que o TEXTO da política tem o bypass, sem precisar
 * montar dado válido pras 7 tabelas (FKs bem diferentes entre elas). Two
 * casos acima (emit_event, fn_conversation_assign) já provam o
 * comportamento fim-a-fim; aqui é a rede de segurança de que nenhuma das
 * sete ficou pra trás.
 */
describe("políticas de RLS — o bypass está no texto das 7 corrigidas", () => {
  const POLICIES: Array<[string, string]> = [
    ["message_templates", "message_templates_write"],
    ["conversation_notes", "conversation_notes_write"],
    ["ai_agent_versions", "tenant_isolation_ai_agent_versions_select"],
    ["ai_agent_versions", "tenant_isolation_ai_agent_versions_write"],
    ["ai_routers", "tenant_isolation_ai_routers_select"],
    ["ai_routers", "tenant_isolation_ai_routers_write"],
    ["ai_router_members", "tenant_isolation_ai_router_members_select"],
    ["ai_router_members", "tenant_isolation_ai_router_members_write"],
    ["ai_purpose_bindings", "tenant_isolation_ai_purpose_bindings_select"],
    ["ai_purpose_bindings", "tenant_isolation_ai_purpose_bindings_write"],
    ["ai_provider_credentials", "tenant_isolation_ai_provider_credentials_write"],
  ];

  it.each(POLICIES)("⭐ %s.%s tem fn_is_platform_admin no qual/with_check", (tabela, politica) => {
    const out = sql(`
      select coalesce(qual, '') || '|' || coalesce(with_check, '')
        from pg_policies
        where schemaname = 'public' and tablename = '${tabela}' and policyname = '${politica}';
    `);
    expect(lastLine(out)).toContain("fn_is_platform_admin");
  });
});
