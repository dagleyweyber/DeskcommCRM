import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 0200 — agenda por SALA.
 *
 * A trava contra dois atendimentos na mesma sala e horário mora no BANCO
 * (constraint de exclusão), não só no TypeScript: antes, duas marcações
 * simultâneas passavam as duas pela checagem de "horário livre".
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

const ORG = "a90da000-0000-4000-8000-0000000002a1";
const SALA_1 = "a90da000-0000-4000-8000-0000000002b1";
const SALA_2 = "a90da000-0000-4000-8000-0000000002b2";
const SERVICO = "a90da000-0000-4000-8000-0000000002c1";
let contato = "";

const DEZ = "2026-11-10T13:00:00.000Z"; // 10:00 em São Paulo

async function marca(sala: string | null, inicio: string, minutos: number, status = "pending"): Promise<void> {
  const cancelado = status === "cancelled";
  await pool.query(
    `insert into calendar_appointments
       (organization_id, event_type_id, room_id, title, starts_at, ends_at, status, contact_id,
        cancelled_at, cancellation_reason)
     values ($1, $2, $3, 'Sessão', $4, $4::timestamptz + make_interval(mins => $5), $6, $7,
             case when $8 then now() end, case when $8 then 'teste' end)`,
    [ORG, SERVICO, sala, inicio, minutos, status, contato, cancelado],
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
     values ($1, 'org-agenda-por-sala', 'Sala LTDA', 'Sala')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into calendar_rooms (id, organization_id, name, position) values
       ($1, $3, 'Sala 1', 1000), ($2, $3, 'Sala 2', 2000)`,
    [SALA_1, SALA_2, ORG],
  );
  await pool.query(
    `insert into calendar_event_types (id, organization_id, name, slug, duration_minutes)
     values ($1, $2, 'Laser', 'laser', 60)`,
    [SERVICO, ORG],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source)
     values ($1, 'Paciente Sala', '+5511900002001', 'whatsapp') returning id`,
    [ORG],
  );
  contato = rows[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("agenda por sala (0200)", () => {
  it("⭐ a mesma sala recusa dois compromissos que se sobrepõem (23P01)", async () => {
    await marca(SALA_1, DEZ, 60);
    expect(await codigoDoErro(marca(SALA_1, "2026-11-10T13:30:00.000Z", 30))).toBe("23P01");
  });

  it("outra sala no mesmo horário é permitida", async () => {
    expect(await codigoDoErro(marca(SALA_2, DEZ, 60))).toBeNull();
  });

  it("encostar na borda (fim de um = início do outro) não é sobreposição", async () => {
    expect(await codigoDoErro(marca(SALA_1, "2026-11-10T14:00:00.000Z", 30))).toBeNull();
  });

  it("cancelado e falta não ocupam a sala", async () => {
    expect(await codigoDoErro(marca(SALA_1, DEZ, 60, "cancelled"))).toBeNull();
    expect(await codigoDoErro(marca(SALA_1, DEZ, 60, "no_show"))).toBeNull();
  });

  it("'Não confirmado' (declined) continua ocupando — a vaga não se perde por um clique do cliente", async () => {
    await marca(SALA_2, "2026-11-11T13:00:00.000Z", 60, "declined");
    expect(await codigoDoErro(marca(SALA_2, "2026-11-11T13:00:00.000Z", 60))).toBe("23P01");
  });

  it("compromisso novo nasce 'pending' (Agendado), não 'confirmed'", async () => {
    const { rows } = await pool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'calendar_appointments' and column_name = 'status'`,
    );
    expect(rows[0]!.column_default).toContain("pending");
  });

  it("RLS ligada nas tabelas novas", async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in ('calendar_rooms', 'calendar_settings', 'calendar_event_type_rooms')
        order by relname`,
    );
    expect(rows).toEqual([
      { relname: "calendar_event_type_rooms", relrowsecurity: true },
      { relname: "calendar_rooms", relrowsecurity: true },
      { relname: "calendar_settings", relrowsecurity: true },
    ]);
  });
});
