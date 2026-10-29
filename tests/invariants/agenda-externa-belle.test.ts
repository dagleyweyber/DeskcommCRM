import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 0205 — agenda externa (Belle).
 *
 * O que só o banco garante e por isso se prova contra o Postgres real:
 *  - o encaixe do Belle (dois agendamentos na mesma sala e horário, que o Belle
 *    permite) ENTRA — recusá-lo esconderia da Agenda um horário que existe;
 *  - a trava de sala continua valendo entre os marcados no CRM, e também entre
 *    um marcado no CRM e… outro marcado no CRM, mesmo com importados na sala;
 *  - o mesmo código do Belle não entra duas vezes (idempotência da importação);
 *  - o token não aparece na view que a tela lê.
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

const ORG = "b311e000-0000-4000-8000-000000000001";
const SALA = "b311e000-0000-4000-8000-000000000002";
let contato = "";

const DEZ = "2026-11-10T13:00:00.000Z";

async function marca(opts: { inicio: string; minutos: number; externo?: string | null }): Promise<void> {
  await pool.query(
    `insert into calendar_appointments
       (organization_id, room_id, title, starts_at, ends_at, status, contact_id, source,
        external_provider, external_id)
     values ($1, $2, 'Sessão', $3, $3::timestamptz + make_interval(mins => $4), 'pending', $5,
             case when $6::text is null then 'manual' else 'belle' end,
             case when $6::text is null then null else 'belle' end, $6)`,
    [ORG, SALA, opts.inicio, opts.minutos, contato, opts.externo ?? null],
  );
}

async function codigoDoErro(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "sem_codigo";
  }
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-agenda-belle', 'Belle LTDA', 'Belle')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into calendar_rooms (id, organization_id, name, position, external_provider, external_id)
     values ($1, $2, 'Laser 01', 1000, 'belle', '24142')`,
    [SALA, ORG],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source)
     values ($1, 'Paciente Belle', '+5581987561002', 'belle') returning id`,
    [ORG],
  );
  contato = rows[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from calendar_integrations where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("agenda externa (0205)", () => {
  it("⭐ encaixe do Belle na mesma sala e horário entra", async () => {
    await marca({ inicio: DEZ, minutos: 35, externo: "74162300" });
    expect(await codigoDoErro(marca({ inicio: "2026-11-10T13:10:00.000Z", minutos: 10, externo: "74162336" }))).toBeNull();
  });

  it("⭐ a trava continua entre os marcados no CRM", async () => {
    const onze = "2026-11-10T14:00:00.000Z";
    await marca({ inicio: onze, minutos: 60 });
    expect(await codigoDoErro(marca({ inicio: "2026-11-10T14:30:00.000Z", minutos: 30 }))).toBe("23P01");
  });

  it("⭐ o mesmo código do Belle não entra duas vezes (23505)", async () => {
    expect(await codigoDoErro(marca({ inicio: "2026-11-11T13:00:00.000Z", minutos: 30, externo: "74162300" }))).toBe("23505");
  });

  it("provedor fora do vocabulário é recusado", async () => {
    expect(
      await codigoDoErro(
        pool.query(
          `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id, external_provider, external_id)
           values ($1, 'x', now(), now() + interval '1 hour', $2, 'outro', '1')`,
          [ORG, contato],
        ),
      ),
    ).toBe("23514");
  });

  it("uma conexão por organização e provedor; a view segura não expõe o token", async () => {
    const inserir = () =>
      pool.query(
        `insert into calendar_integrations (organization_id, provider, credential_encrypted, credential_last4, external_account_id)
         values ($1, 'belle', '\\x00'::bytea, 'c42b', '1')`,
        [ORG],
      );
    await inserir();
    expect(await codigoDoErro(inserir())).toBe("23505");

    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'calendar_integrations_safe'`,
    );
    const colunas = rows.map((r) => r.column_name);
    expect(colunas).toContain("credential_last4");
    expect(colunas).not.toContain("credential_encrypted");
  });

  it("anon não lê a conexão nem a view", async () => {
    const { rows } = await pool.query<{ t: boolean; v: boolean }>(
      `select has_table_privilege('anon', 'public.calendar_integrations', 'select') as t,
              has_table_privilege('anon', 'public.calendar_integrations_safe', 'select') as v`,
    );
    expect(rows[0]).toEqual({ t: false, v: false });
  });
});
