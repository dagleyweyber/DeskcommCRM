import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 0224 — Uno e Zandu como sistemas de agenda (além do Belle).
 *
 * O que só o banco garante:
 *  - 'uno' e 'zandu' entram nas duas colunas de provedor; valor fora da lista não;
 *  - conexão SEM credencial entra (o Uno recebe aviso sem credencial);
 *  - o endereço do aviso é único entre todas as organizações;
 *  - o aviso guardado não é legível por anon e não é gravável pelo navegador.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG_A = "c0224000-0000-4000-8000-00000000000a";
const ORG_B = "c0224000-0000-4000-8000-00000000000b";
let contato = "";

async function codigoDoErro(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "sem_codigo";
  }
}

beforeAll(async () => {
  for (const [id, slug] of [[ORG_A, "org-0224-a"], [ORG_B, "org-0224-b"]] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $2, $2) on conflict (id) do nothing`,
      [id, slug],
    );
  }
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source) values ($1, 'Paciente Uno', '+5581987560224', 'uno') returning id`,
    [ORG_A],
  );
  contato = rows[0]!.id;
});

afterAll(async () => {
  for (const org of [ORG_A, ORG_B]) {
    await pool.query("delete from calendar_appointments where organization_id = $1", [org]);
    await pool.query("delete from calendar_integrations where organization_id = $1", [org]);
    await pool.query("delete from contacts where organization_id = $1", [org]);
    await pool.query("delete from organizations where id = $1", [org]);
  }
  await pool.end();
});

describe("agenda externa — Uno e Zandu (0224)", () => {
  it("⭐ conexão do Uno sem credencial e sem conta entra; a do Zandu também", async () => {
    expect(
      await codigoDoErro(
        pool.query(
          `insert into calendar_integrations (organization_id, provider, inbound_path_token, inbound_secret_hash) values ($1, 'uno', 'caminho-a-uno-0224', 'abc')`,
          [ORG_A],
        ),
      ),
    ).toBeNull();
    expect(
      await codigoDoErro(
        pool.query(
          `insert into calendar_integrations (organization_id, provider, credential_encrypted, credential_last4, inbound_path_token) values ($1, 'zandu', '\\x00'::bytea, 'abcd', 'caminho-a-zandu-0224')`,
          [ORG_A],
        ),
      ),
    ).toBeNull();
  });

  it("provedor fora da lista continua recusado", async () => {
    expect(
      await codigoDoErro(pool.query(`insert into calendar_integrations (organization_id, provider) values ($1, 'outro')`, [ORG_B])),
    ).toBe("23514");
  });

  it("⭐ o endereço do aviso é único entre organizações (resolve UMA conexão)", async () => {
    expect(
      await codigoDoErro(
        pool.query(`insert into calendar_integrations (organization_id, provider, inbound_path_token) values ($1, 'uno', 'caminho-a-uno-0224')`, [ORG_B]),
      ),
    ).toBe("23505");
  });

  it("agendamento importado do Uno/Zandu entra; o mesmo código do mesmo sistema não duplica", async () => {
    const marca = (provedor: string, codigo: string) =>
      pool.query(
        `insert into calendar_appointments (organization_id, title, starts_at, ends_at, status, contact_id, source, external_provider, external_id)
         values ($1, 'Sessão', now(), now() + interval '30 min', 'pending', $2, $3, $3, $4)`,
        [ORG_A, contato, provedor, codigo],
      );
    expect(await codigoDoErro(marca("uno", "123"))).toBeNull();
    expect(await codigoDoErro(marca("zandu", "123"))).toBeNull();
    expect(await codigoDoErro(marca("uno", "123"))).toBe("23505");
  });

  it("⭐ aviso guardado: anon não lê; o navegador (authenticated) não grava", async () => {
    const { rows } = await pool.query<{ anon_le: boolean; auth_grava: boolean; auth_altera: boolean; rls: boolean }>(
      `select has_table_privilege('anon', 'public.calendar_integration_events', 'select') as anon_le,
              has_table_privilege('authenticated', 'public.calendar_integration_events', 'insert') as auth_grava,
              has_table_privilege('authenticated', 'public.calendar_integration_events', 'update') as auth_altera,
              (select relrowsecurity from pg_class where oid = 'public.calendar_integration_events'::regclass) as rls`,
    );
    expect(rows[0]).toEqual({ anon_le: false, auth_grava: false, auth_altera: false, rls: true });
  });

  it("desconectar apaga os avisos da conexão junto (cascade)", async () => {
    const { rows: integ } = await pool.query<{ id: string }>(
      `select id from calendar_integrations where organization_id = $1 and provider = 'uno'`,
      [ORG_A],
    );
    await pool.query(
      `insert into calendar_integration_events (organization_id, integration_id, event_type, external_id, payload) values ($1, $2, 'APPOINTMENT_CREATED', '1', '{}'::jsonb)`,
      [ORG_A, integ[0]!.id],
    );
    await pool.query(`delete from calendar_integrations where id = $1`, [integ[0]!.id]);
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from calendar_integration_events where integration_id = $1`,
      [integ[0]!.id],
    );
    expect(rows[0]!.n).toBe("0");
  });
});
