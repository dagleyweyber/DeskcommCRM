import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { registrarRespostaDeConfirmacao } from "@/lib/agenda/confirmacao";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * Migration 0211 — UM aviso por paciente e dia.
 *
 * B'Laser Parnamirim: o Belle sobe o pacote como 2–7 agendamentos no mesmo dia e a
 * automação mandava uma confirmação por agendamento, cada uma com um horário.
 * Decisões do dono do produto (2026-11-04): uma mensagem só, com o horário de
 * CHEGADA (o líder = o mais cedo do dia); serviços misturados continuam gerando uma
 * mensagem por automação; "Confirmar" vale para o dia, "Preciso remarcar" desmarca o
 * dia todo com UM aviso na Central.
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

const ORG = "a90da000-0000-4000-8000-0000000004a1";
const SESSION = "a90da000-0000-4000-8000-0000000004b1";
const LASER = "a90da000-0000-4000-8000-0000000004c1";
const FACIAL = "a90da000-0000-4000-8000-0000000004c2";
const A_TODOS = "a90da000-0000-4000-8000-0000000004d1";
const A_LASER = "a90da000-0000-4000-8000-0000000004d2";
const A_FACIAL = "a90da000-0000-4000-8000-0000000004d3";
const A_CONFIRMA = "a90da000-0000-4000-8000-0000000004d4";

/** 11:00Z = 08:00 em São Paulo (UTC-3, sem horário de verão desde 2019). */
const AGORA = "2026-03-10T11:00:00.000Z";
const SP_08_20 = "2026-03-10T11:20:00.000Z";
const SP_08_50 = "2026-03-10T11:50:00.000Z";
const SP_09_20 = "2026-03-10T12:20:00.000Z";
const SP_09_50 = "2026-03-10T12:50:00.000Z";
const SP_08_10 = "2026-03-10T11:10:00.000Z";
const AMANHA_08_20 = "2026-03-11T11:20:00.000Z";

let contato = "";
let outroContato = "";
let seq = 0;

async function agendamento(
  inicio: string,
  opts: { contactId?: string; servico?: string | null; status?: string; minutos?: number } = {},
): Promise<string> {
  const status = opts.status ?? "pending";
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments
       (organization_id, event_type_id, title, starts_at, ends_at, status, contact_id, cancelled_at, cancellation_reason)
     values ($1, $2, 'Sessão', $3, $3::timestamptz + make_interval(mins => $4), $5, $6,
             case when $5 = 'cancelled' then now() end, case when $5 = 'cancelled' then 'teste' end)
     returning id`,
    [ORG, opts.servico ?? null, inicio, opts.minutos ?? 30, status, opts.contactId ?? contato],
  );
  return rows[0]!.id;
}

async function devidos(automacao: string, agora = AGORA): Promise<{ activity_id: string; scheduled_at: string }[]> {
  const { rows } = await pool.query<{ activity_id: string; scheduled_at: Date }>(
    "select activity_id, scheduled_at from fn_due_appointment_reminders($1, $2, $3)",
    [ORG, automacao, agora],
  );
  return rows.map((r) => ({ activity_id: r.activity_id, scheduled_at: r.scheduled_at.toISOString() }));
}

async function enviado(automacao: string, agendamentoId: string, wamid?: string) {
  await pool.query(
    `insert into whatsapp_template_automation_sends
       (automation_id, organization_id, contact_id, occurrence_key, external_id, status, appointment_id)
     select $1::uuid, $2::uuid, a.contact_id, a.id::text, $4::text, 'sent', a.id from calendar_appointments a where a.id = $3::uuid`,
    [automacao, ORG, agendamentoId, wamid ?? null],
  );
}

async function status(id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>("select status from calendar_appointments where id = $1", [id]);
  return rows[0]!.status;
}

async function ativa(id: string, ligada: boolean) {
  await pool.query("update whatsapp_template_automations set status = $2 where id = $1", [id, ligada ? "active" : "paused"]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-um-aviso-por-dia', 'Um Aviso LTDA', 'Um Aviso') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000401', '401', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into calendar_event_types (id, organization_id, name, slug) values ($1, $3, 'Laser', 'laser'), ($2, $3, 'Facial', 'facial')`,
    [LASER, FACIAL, ORG],
  );
  for (const [id, nome, servico, confirma] of [
    [A_TODOS, "Todos", null, null],
    [A_LASER, "Laser", LASER, null],
    [A_FACIAL, "Facial", FACIAL, null],
    [A_CONFIRMA, "Confirma", null, "Confirmar"],
  ] as const) {
    await pool.query(
      `insert into whatsapp_template_automations
         (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language,
          variable_mapping, status, event_type_id, confirm_button_text, decline_button_text)
       values ($1, $2, $3, 'appointment_reminder', $4, 'modelo', 'pt_BR', '{}'::jsonb, 'paused', $5, $6, $7)`,
      [id, ORG, nome, SESSION, servico, confirma, confirma ? "Preciso reagendar" : null],
    );
  }
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source) values
       ($1, 'Paciente Pacote', '+5581900000401', 'whatsapp'),
       ($1, 'Outra Paciente', '+5581900000402', 'whatsapp') returning id`,
    [ORG],
  );
  contato = rows[0]!.id;
  outroContato = rows[1]!.id;
});

beforeEach(async () => {
  seq += 1;
  await pool.query("delete from whatsapp_template_automation_sends where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  for (const id of [A_TODOS, A_LASER, A_FACIAL, A_CONFIRMA]) await ativa(id, false);
});

afterAll(async () => {
  await pool.query("delete from whatsapp_template_automation_sends where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("fn_due_appointment_reminders — só o líder do dia gera mensagem (0211)", () => {
  it("⭐ 3 agendamentos no mesmo dia → UMA mensagem, a do horário de chegada", async () => {
    await ativa(A_TODOS, true);
    const lider = await agendamento(SP_08_20);
    await agendamento(SP_08_50);
    await agendamento(SP_09_20);

    const rows = await devidos(A_TODOS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ activity_id: lider, scheduled_at: SP_08_20 });
  });

  it("⭐ o líder já foi avisado → os irmãos continuam calados", async () => {
    await ativa(A_TODOS, true);
    const lider = await agendamento(SP_08_20);
    await agendamento(SP_08_50);
    await agendamento(SP_09_20);
    await enviado(A_TODOS, lider);

    expect(await devidos(A_TODOS)).toEqual([]);
  });

  it("⭐ o líder foi cancelado → o próximo assume, com o NOVO horário de chegada", async () => {
    await ativa(A_TODOS, true);
    const lider = await agendamento(SP_08_20);
    const segundo = await agendamento(SP_08_50);
    await agendamento(SP_09_20);
    await enviado(A_TODOS, lider);
    await pool.query("update calendar_appointments set status='cancelled', cancelled_at=now(), cancellation_reason='x' where id=$1", [lider]);

    const rows = await devidos(A_TODOS);
    expect(rows).toEqual([{ activity_id: segundo, scheduled_at: SP_08_50 }]);
  });

  it("⭐ entrou um encaixe MAIS CEDO depois do aviso → a chegada mudou, o paciente recebe a atualizada", async () => {
    await ativa(A_TODOS, true);
    const lider = await agendamento(SP_08_20);
    await agendamento(SP_08_50);
    await enviado(A_TODOS, lider);
    const encaixe = await agendamento(SP_08_10);

    expect(await devidos(A_TODOS)).toEqual([{ activity_id: encaixe, scheduled_at: SP_08_10 }]);
  });

  it("⭐ entrou um procedimento DEPOIS da chegada → o que o paciente vê não mudou, sem mensagem repetida", async () => {
    await ativa(A_TODOS, true);
    const lider = await agendamento(SP_08_20);
    await enviado(A_TODOS, lider);
    await agendamento(SP_09_50);

    expect(await devidos(A_TODOS)).toEqual([]);
  });

  it("⭐ a visita já começou → o segundo procedimento NÃO vira 'líder' no meio da visita", async () => {
    await ativa(A_TODOS, true);
    await agendamento(SP_08_20);
    await agendamento(SP_08_50);
    await agendamento(SP_09_20);

    // 08:30 em SP: o líder (08:20) já começou; 08:50 e 09:20 ainda não.
    expect(await devidos(A_TODOS, "2026-03-10T11:30:00.000Z")).toEqual([]);
  });

  it("o líder que já compareceu também segura os irmãos", async () => {
    await ativa(A_TODOS, true);
    await agendamento(SP_08_20, { status: "completed" });
    await agendamento(SP_09_20);

    expect(await devidos(A_TODOS, "2026-03-10T11:45:00.000Z")).toEqual([]);
  });

  it("dias e pacientes diferentes são grupos diferentes", async () => {
    await ativa(A_TODOS, true);
    const hoje = await agendamento(SP_08_20);
    const amanha = await agendamento(AMANHA_08_20);
    const outra = await agendamento(SP_08_50, { contactId: outroContato });

    const ids = (await devidos(A_TODOS)).map((r) => r.activity_id).sort();
    expect(ids).toEqual([hoje, amanha, outra].sort());
  });

  it("⭐ serviços misturados: cada automação manda a SUA mensagem (decisão: aceitar 2)", async () => {
    await ativa(A_LASER, true);
    await ativa(A_FACIAL, true);
    const laser1 = await agendamento(SP_08_20, { servico: LASER });
    await agendamento(SP_08_50, { servico: LASER });
    const facial = await agendamento(SP_09_20, { servico: FACIAL });

    expect(await devidos(A_LASER)).toEqual([{ activity_id: laser1, scheduled_at: SP_08_20 }]);
    expect(await devidos(A_FACIAL)).toEqual([{ activity_id: facial, scheduled_at: SP_09_20 }]);
  });

  it("⭐ automação de confirmação: líder já confirmado → os irmãos 'Agendado' NÃO assumem", async () => {
    await ativa(A_CONFIRMA, true);
    await agendamento(SP_08_20, { status: "confirmed" });
    await agendamento(SP_08_50);

    expect(await devidos(A_CONFIRMA)).toEqual([]);
  });
});

describe("fn_grupo_do_agendamento — quem entra no mesmo aviso", () => {
  it("devolve o paciente no dia, no escopo da automação, sem cancelados nem outros dias/pacientes", async () => {
    const a = await agendamento(SP_08_20, { servico: LASER });
    const b = await agendamento(SP_08_50, { servico: LASER });
    await agendamento(SP_09_20, { servico: FACIAL }); // outro serviço
    await agendamento(SP_09_50, { servico: LASER, status: "cancelled" });
    await agendamento(AMANHA_08_20, { servico: LASER }); // outro dia
    await agendamento(SP_08_50, { servico: LASER, contactId: outroContato }); // outro paciente

    const { rows } = await pool.query<{ id: string }>(
      "select id from fn_grupo_do_agendamento($1, $2, $3) order by starts_at, id",
      [ORG, A_LASER, a],
    );
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  it("automação de 'todos' não inclui o serviço que tem automação própria ativa", async () => {
    await ativa(A_LASER, true);
    const facial = await agendamento(SP_08_20, { servico: FACIAL });
    await agendamento(SP_08_50, { servico: LASER });

    const { rows } = await pool.query<{ id: string }>("select id from fn_grupo_do_agendamento($1, $2, $3)", [ORG, A_TODOS, facial]);
    expect(rows.map((r) => r.id)).toEqual([facial]);
  });
});

describe("resposta ao botão vale para o DIA (0211)", () => {
  async function pacote() {
    const ids = [await agendamento(SP_08_20), await agendamento(SP_08_50), await agendamento(SP_09_20)];
    await enviado(A_CONFIRMA, ids[0]!, `wamid.PACOTE${seq}`);
    return { ids, wamid: `wamid.PACOTE${seq}` };
  }

  it("⭐ 'Confirmar' confirma TODOS os agendamentos do dia", async () => {
    const { ids, wamid } = await pacote();
    const r = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });

    expect(r).toMatchObject({ resultado: "atualizado", status: "confirmed", agendamentos: 3 });
    expect(await Promise.all(ids.map(status))).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("⭐ 'Preciso reagendar' desmarca o dia todo e abre UM aviso listando os horários", async () => {
    const { ids, wamid } = await pacote();
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Preciso reagendar", payload: null });
    // re-entrega do webhook: não duplica o aviso
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Preciso reagendar", payload: null });

    expect(await Promise.all(ids.map(status))).toEqual(["declined", "declined", "declined"]);
    const { rows } = await pool.query<{ title: string }>(
      "select title from agent_inbox_items where organization_id=$1 and kind='appointment_declined' and status='open'",
      [ORG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("3 agendamentos");
    expect(rows[0]!.title).toContain("08:20, 08:50 e 09:20");
  });

  it("apertar o mesmo botão de novo não muda nada", async () => {
    const { wamid } = await pacote();
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });
    const segunda = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });
    expect(segunda).toEqual({ resultado: "ignorado", motivo: "ja_registrado" });
  });

  it("⭐ procedimento que entrou DEPOIS da confirmação é coberto no próximo toque", async () => {
    const { wamid } = await pacote();
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });
    const tardio = await agendamento(SP_09_50);

    const r = await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });
    expect(r).toMatchObject({ resultado: "atualizado", agendamentos: 1 });
    expect(await status(tardio)).toBe("confirmed");
  });

  it("⭐ não confirma o que já terminou nem o que foi cancelado", async () => {
    const ids = [await agendamento(SP_08_20), await agendamento(SP_08_50, { status: "completed" }), await agendamento(SP_09_20, { status: "cancelled" })];
    await enviado(A_CONFIRMA, ids[0]!, "wamid.MISTO");
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: "wamid.MISTO", texto: "Confirmar", payload: null });

    expect(await Promise.all(ids.map(status))).toEqual(["confirmed", "completed", "cancelled"]);
  });

  it("outro dia do mesmo paciente não é tocado", async () => {
    const { wamid } = await pacote();
    const amanha = await agendamento(AMANHA_08_20);
    await registrarRespostaDeConfirmacao(admin, { organizationId: ORG, respondeuA: wamid, texto: "Confirmar", payload: null });
    expect(await status(amanha)).toBe("pending");
  });
});
