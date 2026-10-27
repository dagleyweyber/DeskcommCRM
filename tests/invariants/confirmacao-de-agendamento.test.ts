import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { registrarRespostaDeConfirmacao } from "@/lib/agenda/confirmacao";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * Migration 0201 — o cliente toca no botão do modelo e o compromisso muda de
 * status na Agenda sozinho. Contra Postgres real: a cadeia resposta →
 * envio (external_id) → compromisso (appointment_id) → botão da automação.
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
const admin = pgComoSupabase(pool);

const ORG = "a90da000-0000-4000-8000-0000000003a1";
const ORG_B = "a90da000-0000-4000-8000-0000000003a2";
const SESSION = "a90da000-0000-4000-8000-0000000003b1";
const AUTOMACAO = "a90da000-0000-4000-8000-0000000003c1";
let contato = "";
let seq = 0;

/** Compromisso + o envio da automação para ele. Devolve {id, wamid}. */
async function enviado(status = "pending"): Promise<{ id: string; wamid: string }> {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments (organization_id, title, starts_at, ends_at, status, contact_id)
     values ($1, 'Sessão', now() + make_interval(days => $2), now() + make_interval(days => $2) + interval '1 hour', $3, $4)
     returning id`,
    [ORG, seq, status, contato],
  );
  const id = rows[0]!.id;
  const wamid = `wamid.CONFIRMA${seq}`;
  await pool.query(
    `insert into whatsapp_template_automation_sends
       (automation_id, organization_id, contact_id, occurrence_key, external_id, status, appointment_id)
     values ($1, $2, $3, $4, $5, 'sent', $6)`,
    [AUTOMACAO, ORG, contato, id, wamid, id],
  );
  return { id, wamid };
}

async function statusDe(id: string): Promise<{ status: string; respondeu: boolean }> {
  const { rows } = await pool.query<{ status: string; respondeu: boolean }>(
    "select status, client_responded_at is not null as respondeu from calendar_appointments where id = $1",
    [id],
  );
  return rows[0]!;
}

async function avisosAbertos(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from agent_inbox_items where kind = 'appointment_declined' and ref_id = $1 and status = 'open'",
    [id],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-confirmacao', 'Confirma LTDA', 'Confirma'),
       ($2, 'org-confirmacao-b', 'Outra LTDA', 'Outra')
     on conflict (id) do nothing`,
    [ORG, ORG_B],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000301', '301', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into whatsapp_template_automations
       (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language,
        variable_mapping, status, timing_kind, timing_value, confirm_button_text, decline_button_text)
     values ($1, $2, 'Confirmação', 'appointment_reminder', $3, 'confirmacao', 'pt_BR', '{}'::jsonb,
             'active', 'days_before', 1, 'Confirmo presença', 'Preciso remarcar')`,
    [AUTOMACAO, ORG, SESSION],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source)
     values ($1, 'Paciente Confirma', '+5511900000302', 'whatsapp') returning id`,
    [ORG],
  );
  contato = rows[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from whatsapp_template_automation_sends where organization_id = $1", [ORG]);
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_B]]);
  await pool.end();
});

describe("confirmação automática pela resposta ao botão (0201)", () => {
  it("⭐ 'Confirmo presença' → Confirmado, marcando que foi o cliente", async () => {
    const c = await enviado();
    const r = await registrarRespostaDeConfirmacao(admin, {
      organizationId: ORG,
      respondeuA: c.wamid,
      texto: "Confirmo presença",
      payload: null,
    });
    expect(r).toMatchObject({ resultado: "atualizado", status: "confirmed" });
    expect(await statusDe(c.id)).toEqual({ status: "confirmed", respondeu: true });
  });

  it("⭐ 'Preciso remarcar' → Não confirmado + UM aviso na Central (re-entrega não duplica)", async () => {
    const c = await enviado();
    for (let i = 0; i < 2; i++) {
      await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: c.wamid, texto: "Preciso remarcar", payload: null });
    }
    expect(await statusDe(c.id)).toEqual({ status: "declined", respondeu: true });
    expect(await avisosAbertos(c.id)).toBe(1);
  });

  it("o cliente muda de ideia: depois de 'Preciso remarcar', 'Confirmo presença' confirma", async () => {
    const c = await enviado();
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: c.wamid, texto: "Preciso remarcar", payload: null });
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: c.wamid, texto: "Confirmo presença", payload: null });
    expect((await statusDe(c.id)).status).toBe("confirmed");
  });

  it("botão desconhecido não muda nada", async () => {
    const c = await enviado();
    const r = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: c.wamid, texto: "Ver endereço", payload: null });
    expect(r).toMatchObject({ resultado: "ignorado" });
    expect(await statusDe(c.id)).toEqual({ status: "pending", respondeu: false });
  });

  it("compromisso já encerrado (compareceu) não volta para 'Confirmado'", async () => {
    const c = await enviado("completed");
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: c.wamid, texto: "Confirmo presença", payload: null });
    expect((await statusDe(c.id)).status).toBe("completed");
  });

  it("⭐ isolamento: a resposta só vale dentro da organização do envio", async () => {
    const c = await enviado();
    const r = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG_B, respondeuA: c.wamid, texto: "Confirmo presença", payload: null });
    expect(r).toMatchObject({ resultado: "ignorado" });
    expect((await statusDe(c.id)).status).toBe("pending");
  });

  it("mensagem que não responde a um envio de confirmação é ignorada", async () => {
    const r = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: "wamid.QUALQUER", texto: "Confirmo presença", payload: null });
    expect(r).toEqual({ resultado: "ignorado", motivo: "nao_e_resposta_de_confirmacao" });
  });
});
