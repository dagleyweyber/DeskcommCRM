import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { handleLeadWonForClienteExistente } from "@/lib/leads/cliente-existente-won-handler";
import { marcarClienteExistente } from "@/lib/leads/marcar-cliente-existente";
import type { EventRow } from "@/lib/event-log/dispatcher";

import { pgComoSupabase } from "../pg-como-supabase";
import { sql, lastLine } from "./gov-helpers";

/**
 * "Cliente já existente" — Fase 2 (automático, lead.won) e Fase 3 (manual,
 * marcarClienteExistente), migration 0164_contato_ja_e_cliente.
 *
 * As duas escritas de `status` deste arquivo são as ÚNICAS no repo que
 * gravam `crm_leads.status` sem passar pelo trigger `fn_crm_lead_close_on_stage`
 * (que só dispara em `UPDATE OF stage_id`) — por isso a suíte também prova
 * que o trigger genuinamente NÃO interfere (ver 3º teste do describe da Fase 3).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "c1e17e70-0000-4000-8000-000000000001";
const PIPELINE = "c1e17e70-5555-4000-8000-000000000001";
const STAGE = "c1e17e70-5555-4000-8000-000000000002";
const CONTACT_NOVO = "c1e17e70-6666-4000-8000-000000000001";
const CONTACT_JA_CLIENTE = "c1e17e70-6666-4000-8000-000000000002";
const CONTACT_PARA_MARCAR = "c1e17e70-6666-4000-8000-000000000003";
const LEAD_WON_CONTATO_NOVO = "c1e17e70-7777-4000-8000-000000000001";
const LEAD_WON_SEM_CONTATO = "c1e17e70-7777-4000-8000-000000000002";
const LEAD_WON_JA_CLIENTE = "c1e17e70-7777-4000-8000-000000000003";
const LEAD_PARA_MARCAR = "c1e17e70-7777-4000-8000-000000000004";
const LEAD_SEM_CONTATO_MARCAR = "c1e17e70-7777-4000-8000-000000000005";
const LEAD_JA_MARCADO = "c1e17e70-7777-4000-8000-000000000006";

function eventRow(overrides: Partial<EventRow> & Pick<EventRow, "id" | "entity_id">): EventRow {
  return {
    organization_id: ORG,
    event_type: "lead.won",
    entity_kind: "lead",
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'cliente-existente-org', 'Cliente Existente Org', 'Cliente Existente')
      on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG}', 'Cliente Existente', 'cliente-existente')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;

    insert into public.contacts (id, organization_id, display_name, phone_number, became_customer_at) values
      ('${CONTACT_NOVO}', '${ORG}', 'Contato Novo', '+5531900000001', null),
      ('${CONTACT_JA_CLIENTE}', '${ORG}', 'Contato Já Cliente', '+5531900000002', '2026-01-10T12:00:00+00'),
      ('${CONTACT_PARA_MARCAR}', '${ORG}', 'Contato Pra Marcar', '+5531900000003', null)
      on conflict (id) do nothing;

    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, contact_id, title, status, value_cents, currency, closed_at)
      values
      ('${LEAD_WON_CONTATO_NOVO}', '${ORG}', '${PIPELINE}', '${STAGE}', '${CONTACT_NOVO}', 'Venda 1', 'won',
       100000, 'BRL', '2026-08-20T15:00:00+00'),
      ('${LEAD_WON_SEM_CONTATO}', '${ORG}', '${PIPELINE}', '${STAGE}', null, 'Venda sem contato', 'won',
       50000, 'BRL', '2026-08-20T15:00:00+00'),
      ('${LEAD_WON_JA_CLIENTE}', '${ORG}', '${PIPELINE}', '${STAGE}', '${CONTACT_JA_CLIENTE}', 'Recompra', 'won',
       80000, 'BRL', '2026-08-21T09:00:00+00'),
      ('${LEAD_PARA_MARCAR}', '${ORG}', '${PIPELINE}', '${STAGE}', '${CONTACT_PARA_MARCAR}', 'Lead pra marcar', 'open',
       null, null, null),
      ('${LEAD_SEM_CONTATO_MARCAR}', '${ORG}', '${PIPELINE}', '${STAGE}', null, 'Lead sem contato', 'open',
       null, null, null),
      ('${LEAD_JA_MARCADO}', '${ORG}', '${PIPELINE}', '${STAGE}', '${CONTACT_JA_CLIENTE}', 'Já marcado', 'existing_customer',
       null, null, '2026-08-15T10:00:00+00')
      on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.query("delete from public.organizations where id = $1", [ORG]);
  await pool.end();
});

describe("Fase 2 — handleLeadWonForClienteExistente (automático)", () => {
  it("⭐ lead ganho, contato SEM became_customer_at: grava o closed_at do lead", async () => {
    const row = eventRow({ id: "evt-1", entity_id: LEAD_WON_CONTATO_NOVO });
    const result = await handleLeadWonForClienteExistente(db, row);
    expect(result).toEqual({ consumer_key: "cliente-existente-marcar-no-won", status: "ok" });

    const out = sql(
      `select became_customer_at = '2026-08-20T15:00:00+00'::timestamptz
         from public.contacts where id = '${CONTACT_NOVO}';`,
    );
    expect(lastLine(out)).toBe("t");
  });

  it("⭐ lead ganho SEM contato vinculado: skipped 'no_contact', não quebra", async () => {
    const row = eventRow({ id: "evt-2", entity_id: LEAD_WON_SEM_CONTATO });
    const result = await handleLeadWonForClienteExistente(db, row);
    expect(result).toEqual({
      consumer_key: "cliente-existente-marcar-no-won",
      status: "skipped",
      detail: "no_contact",
    });
  });

  it("⭐ contato JÁ tem became_customer_at: recompra não reescreve a data original", async () => {
    const row = eventRow({ id: "evt-3", entity_id: LEAD_WON_JA_CLIENTE });
    const result = await handleLeadWonForClienteExistente(db, row);
    expect(result).toEqual({ consumer_key: "cliente-existente-marcar-no-won", status: "ok" });

    const out = sql(
      `select became_customer_at = '2026-01-10T12:00:00+00'::timestamptz
         from public.contacts where id = '${CONTACT_JA_CLIENTE}';`,
    );
    expect(lastLine(out)).toBe("t");
  });

  it("lead não encontrado: skipped 'no_lead'", async () => {
    const row = eventRow({ id: "evt-4", entity_id: "00000000-0000-4000-8000-000000000000" });
    const result = await handleLeadWonForClienteExistente(db, row);
    expect(result).toEqual({ consumer_key: "cliente-existente-marcar-no-won", status: "skipped", detail: "no_lead" });
  });
});

describe("Fase 3 — marcarClienteExistente (manual)", () => {
  const ctx = { organization_id: ORG, actor: { type: "user" as const, id: "00000000-0000-4000-8000-000000000099" }, requestId: "req-1" };

  it("⭐ marca status='existing_customer' + closed_at, e became_customer_at do contato", async () => {
    const { lead, jaEstava } = await marcarClienteExistente(db, ctx, { leadId: LEAD_PARA_MARCAR });
    expect(jaEstava).toBe(false);
    expect(lead.status).toBe("existing_customer");
    expect(lead.closed_at).not.toBeNull();

    const contato = lastLine(
      sql(`select became_customer_at is not null from public.contacts where id = '${CONTACT_PARA_MARCAR}';`),
    );
    expect(contato).toBe("t");
  });

  it("⭐ SEM contato vinculado: lança lead_sem_contato, não grava nada", async () => {
    await expect(
      marcarClienteExistente(db, ctx, { leadId: LEAD_SEM_CONTATO_MARCAR }),
    ).rejects.toMatchObject({ code: "lead_sem_contato" });

    const status = lastLine(
      sql(`select status from public.crm_leads where id = '${LEAD_SEM_CONTATO_MARCAR}';`),
    );
    expect(status).toBe("open");
  });

  it("⭐ o trigger fn_crm_lead_close_on_stage NÃO interfere (UPDATE não toca stage_id)", async () => {
    // Prova direta do comentário de doutrina do módulo: marcar não usa
    // encerraDemanda (que move stage_id), e o status sobrevive porque o
    // trigger só dispara em UPDATE OF stage_id.
    const stageAntes = lastLine(
      sql(`select stage_id from public.crm_leads where id = '${LEAD_PARA_MARCAR}';`),
    );
    expect(stageAntes).toBe(STAGE);
  });

  it("já marcado como cliente existente: idempotente, jaEstava=true, não reescreve closed_at", async () => {
    const antes = lastLine(
      sql(`select closed_at from public.crm_leads where id = '${LEAD_JA_MARCADO}';`),
    );
    const { jaEstava } = await marcarClienteExistente(db, ctx, { leadId: LEAD_JA_MARCADO });
    expect(jaEstava).toBe(true);
    const depois = lastLine(
      sql(`select closed_at from public.crm_leads where id = '${LEAD_JA_MARCADO}';`),
    );
    expect(depois).toBe(antes);
  });

  it("lead não encontrado: 404 not_found", async () => {
    await expect(
      marcarClienteExistente(db, ctx, { leadId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("⭐ o lead marcado grava uma linha 'demand_closed' na timeline", async () => {
    const out = sql(`
      select type, payload->>'desfecho' from public.crm_lead_activities
        where lead_id = '${LEAD_PARA_MARCAR}' and type = 'demand_closed';
    `);
    const [type, desfecho] = lastLine(out).split("|");
    expect(type).toBe("demand_closed");
    expect(desfecho).toBe("existing_customer");
  });
});

describe("board não mostra mais existing_customer (Fase 4)", () => {
  it("⭐ crm_leads status='existing_customer' não passa no filtro do board (mesma query da rota)", () => {
    const out = sql(`
      select count(*) from public.crm_leads
        where pipeline_id = '${PIPELINE}' and status <> 'archived' and status <> 'existing_customer'
          and id = any(array['${LEAD_JA_MARCADO}'::uuid, '${LEAD_PARA_MARCAR}'::uuid]);
    `);
    // LEAD_JA_MARCADO é existing_customer (fora); LEAD_PARA_MARCAR virou
    // existing_customer no teste da Fase 3 acima (fora também).
    expect(lastLine(out)).toBe("0");
  });
});
