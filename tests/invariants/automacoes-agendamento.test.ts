import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { dispatchAutomationsTick } from "@/lib/automations/dispatch";
import type { Message } from "@/lib/types/messaging";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * `fn_due_appointment_reminders` (0169 → 0199 → 0201) + o ciclo completo do
 * despachante, contra Postgres real — mesma filosofia de
 * `campanhas-despacho.test.ts`: `sendMessageHandler` é dublê, o resto
 * (RPC, `ensureConversation`, gravação de dedup) roda código de produção.
 *
 * Desde a 0201 a função lê `calendar_appointments` direto (não a atividade
 * `meeting_scheduled` do negócio): cliente SEM negócio aberto também recebe,
 * e a automação escolhe QUANDO enviar (no dia às 8h, N dias antes, N horas antes).
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

const ORG = "a90da000-0000-4000-8000-000000000001";
const ORG_B = "a90da000-0000-4000-8000-000000000002";
const SESSION = "a90da000-0000-4000-8000-000000000010";
const AUTOMATION = "a90da000-0000-4000-8000-000000000030";

let contato = "";
let contatoSemNegocio = "";
let lead = "";

/** 11:00Z = 08:00 em América/São_Paulo (UTC-3, sem horário de verão desde 2019). */
const HOJE_07H_SP = "2026-03-10T10:00:00.000Z";
const HOJE_08H_SP = "2026-03-10T11:00:00.000Z";
const HOJE_09H_SP = "2026-03-10T12:00:00.000Z";
const HOJE_MEIO_DIA_SP = "2026-03-10T15:00:00.000Z";
const HOJE_15H_SP = "2026-03-10T18:00:00.000Z";
const AMANHA_10H_SP = "2026-03-11T13:00:00.000Z";

async function compromisso(inicioIso: string, opts: { status?: string; contactId?: string } = {}): Promise<string> {
  const status = opts.status ?? "pending";
  const cancelado = status === "cancelled";
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments
       (organization_id, title, starts_at, ends_at, status, contact_id, cancelled_at, cancellation_reason)
     values ($1, 'Consulta', $2, $2::timestamptz + interval '30 minutes', $3, $4,
             case when $5 then now() end, case when $5 then 'teste' end)
     returning id`,
    [ORG, inicioIso, status, opts.contactId ?? contato, cancelado],
  );
  return rows[0]!.id;
}

async function devidos(agora: string, org = ORG): Promise<{ activity_id: string; lead_id: string | null }[]> {
  const { rows } = await pool.query<{ activity_id: string; lead_id: string | null }>(
    "select activity_id, lead_id from fn_due_appointment_reminders($1, $2, $3)",
    [org, AUTOMATION, agora],
  );
  return rows;
}

async function configura(campos: {
  timing_kind?: string;
  timing_value?: number | null;
  confirm_button_text?: string | null;
}) {
  await pool.query(
    `update whatsapp_template_automations
        set timing_kind = $2, timing_value = $3, confirm_button_text = $4
      where id = $1`,
    [AUTOMATION, campos.timing_kind ?? "day_of_8am", campos.timing_value ?? null, campos.confirm_button_text ?? null],
  );
}

async function limpa() {
  await pool.query("delete from whatsapp_template_automation_sends where automation_id = $1", [AUTOMATION]);
  await pool.query("delete from crm_lead_activities where organization_id = $1", [ORG]);
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await configura({});
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-automacoes-agendamento', 'Automação LTDA', 'Automação'),
       ($2, 'org-automacoes-agendamento-b', 'Outra LTDA', 'Outra')
     on conflict (id) do nothing`,
    [ORG, ORG_B],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000099', '888', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, channel_session_id, name, language, status, components, contract_hash)
     values ($1, '888', $2, 'lembrete_consulta', 'pt_BR', 'APPROVED', $3::jsonb, 'hash-agendamento')`,
    [ORG, SESSION, JSON.stringify([{ type: "BODY", text: "Olá {{1}}, sua consulta é hoje." }])],
  );
  await pool.query(
    `insert into whatsapp_template_automations
       (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language, variable_mapping, status)
     values ($1, $2, 'Lembrete de consulta', 'appointment_reminder', $3, 'lembrete_consulta', 'pt_BR', '{"1":{"kind":"contact_first_name"}}'::jsonb, 'active')`,
    [AUTOMATION, ORG, SESSION],
  );

  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source) values
       ($1, 'Paciente Teste', '+5511900000098', 'whatsapp'),
       ($1, 'Paciente Antiga', '+5511900000097', 'whatsapp')
     returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  contatoSemNegocio = c[1]!.id;

  // A organização já NASCE com funil padrão (`fn_seed_default_pipeline_for_org`).
  const { rows: p } = await pool.query<{ id: string }>(
    `select id from crm_pipelines where organization_id = $1 and is_default = true`,
    [ORG],
  );
  const pipelineId = p[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `select id from crm_stages
       where organization_id = $1 and pipeline_id = $2
         and is_archived = false and is_won = false and is_lost = false
       order by position asc limit 1`,
    [ORG, pipelineId],
  );
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, source)
     values ($1, $2, $3, $4, 'Paciente Teste', 'whatsapp') returning id`,
    [ORG, pipelineId, s[0]!.id, contato],
  );
  lead = l[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from calendar_appointments where organization_id = any($1)", [[ORG, ORG_B]]);
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_B]]);
  await pool.end();
});

describe("fn_due_appointment_reminders — lê a Agenda (0201)", () => {
  it("⭐ compromisso hoje, sem envio prévio → aparece, com o negócio aberto do contato", async () => {
    const id = await compromisso(HOJE_15H_SP);
    const rows = await devidos(HOJE_MEIO_DIA_SP);
    expect(rows).toContainEqual({ activity_id: id, lead_id: lead });
    await limpa();
  });

  it("⭐ cliente SEM negócio aberto também recebe (o paciente que volta para a próxima sessão)", async () => {
    const id = await compromisso(HOJE_15H_SP, { contactId: contatoSemNegocio });
    expect(await devidos(HOJE_MEIO_DIA_SP)).toContainEqual({ activity_id: id, lead_id: null });
    await limpa();
  });

  it("⭐ já enviado para este compromisso → some", async () => {
    const id = await compromisso(HOJE_15H_SP);
    await pool.query(
      `insert into whatsapp_template_automation_sends (automation_id, organization_id, contact_id, occurrence_key, status)
       values ($1, $2, $3, $4, 'sent')`,
      [AUTOMATION, ORG, contato, id],
    );
    expect((await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id)).not.toContain(id);
    await limpa();
  });

  it("⭐ envio feito com a chave ANTIGA (id da atividade, antes da 0201) continua valendo — sem mensagem em dobro na virada", async () => {
    const id = await compromisso(HOJE_15H_SP);
    const { rows: act } = await pool.query<{ id: string }>(
      `insert into crm_lead_activities (organization_id, lead_id, contact_id, source_module, source_id, type, payload, performed_at)
       values ($1, $2, $3, 'agenda.agendamentos', $4, 'meeting_scheduled', $5::jsonb, $6) returning id`,
      [ORG, lead, contato, id, JSON.stringify({ scheduled_at: HOJE_15H_SP }), HOJE_08H_SP],
    );
    await pool.query(
      `insert into whatsapp_template_automation_sends (automation_id, organization_id, lead_id, contact_id, occurrence_key, status)
       values ($1, $2, $3, $4, $5, 'sent')`,
      [AUTOMATION, ORG, lead, contato, act[0]!.id],
    );
    expect((await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id)).not.toContain(id);
    await limpa();
  });

  it("⭐ remarcado: o antigo (cancelado) some, o novo aparece — mesmo com o antigo já enviado", async () => {
    const antigo = await compromisso(HOJE_15H_SP, { status: "cancelled" });
    await pool.query(
      `insert into whatsapp_template_automation_sends (automation_id, organization_id, contact_id, occurrence_key, status)
       values ($1, $2, $3, $4, 'sent')`,
      [AUTOMATION, ORG, contato, antigo],
    );
    const novo = await compromisso("2026-03-10T19:00:00.000Z");
    const ids = (await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id);
    expect(ids).toContain(novo);
    expect(ids).not.toContain(antigo);
    await limpa();
  });

  it("compromisso que já começou, faltou ou compareceu não recebe", async () => {
    const passado = await compromisso(HOJE_09H_SP);
    const faltou = await compromisso(HOJE_15H_SP, { status: "no_show" });
    const ids = (await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id);
    expect(ids).not.toContain(passado);
    expect(ids).not.toContain(faltou);
    await limpa();
  });

  it("⭐ automação de CONFIRMAÇÃO (tem botão) só manda para quem ainda está 'Agendado'", async () => {
    const agendado = await compromisso(HOJE_15H_SP);
    const jaConfirmado = await compromisso("2026-03-10T19:00:00.000Z", { status: "confirmed", contactId: contatoSemNegocio });

    await configura({ confirm_button_text: "Confirmo" });
    let ids = (await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id);
    expect(ids).toContain(agendado);
    expect(ids).not.toContain(jaConfirmado);

    // lembrete comum (sem botão) vai para os dois
    await configura({});
    ids = (await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id);
    expect(ids).toEqual(expect.arrayContaining([agendado, jaConfirmado]));
    await limpa();
  });

  it("⭐ '1 dia antes': compromisso amanhã às 10h sai hoje a partir das 8h", async () => {
    const id = await compromisso(AMANHA_10H_SP);
    await configura({ timing_kind: "days_before", timing_value: 1 });
    expect((await devidos(HOJE_07H_SP)).map((r) => r.activity_id)).not.toContain(id);
    expect((await devidos(HOJE_08H_SP)).map((r) => r.activity_id)).toContain(id);

    // no modo "no dia", o de amanhã ainda não está devido hoje
    await configura({});
    expect((await devidos(HOJE_MEIO_DIA_SP)).map((r) => r.activity_id)).not.toContain(id);
    await limpa();
  });

  it("⭐ '2 horas antes': compromisso às 15h sai a partir das 13h", async () => {
    const id = await compromisso(HOJE_15H_SP);
    await configura({ timing_kind: "hours_before", timing_value: 2 });
    expect((await devidos("2026-03-10T15:30:00.000Z")).map((r) => r.activity_id)).not.toContain(id); // 12:30 SP
    expect((await devidos("2026-03-10T16:00:00.000Z")).map((r) => r.activity_id)).toContain(id); // 13:00 SP
    await limpa();
  });

  it("momento inválido é recusado pelo banco (CHECK)", async () => {
    await expect(configura({ timing_kind: "days_before", timing_value: 30 })).rejects.toMatchObject({ code: "23514" });
    await expect(configura({ timing_kind: "day_of_8am", timing_value: 2 })).rejects.toMatchObject({ code: "23514" });
  });

  it("⭐ isolamento entre organizações — automação de outra org nunca vê o compromisso desta", async () => {
    await compromisso(HOJE_15H_SP);
    expect(await devidos(HOJE_MEIO_DIA_SP, ORG_B)).toHaveLength(0);
    await limpa();
  });
});

describe("dispatchAutomationsTick — ciclo completo contra Postgres real", () => {
  it("⭐ um tick às 8h manda o lembrete, grava o dedup E o compromisso; um segundo tick não duplica", async () => {
    const id = await compromisso(HOJE_MEIO_DIA_SP);

    const sendFn = vi.fn(
      async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> =>
        ({ id: "msg-1", status: "sent", external_id: "wamid.LEMBRETE", type: "template" }) as unknown as Message,
    );

    const primeiro = await dispatchAutomationsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date(HOJE_08H_SP),
      timeBudgetMs: 5000,
    });
    expect(primeiro.sent).toBe(1);
    expect(sendFn).toHaveBeenCalledTimes(1);

    const { rows: envios } = await pool.query(
      "select status, external_id, occurrence_key, appointment_id from whatsapp_template_automation_sends where automation_id = $1",
      [AUTOMATION],
    );
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ status: "sent", external_id: "wamid.LEMBRETE", occurrence_key: id, appointment_id: id });

    const segundo = await dispatchAutomationsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date(HOJE_09H_SP),
      timeBudgetMs: 5000,
    });
    expect(segundo.sent).toBe(0);
    expect(sendFn).toHaveBeenCalledTimes(1);

    await limpa();
  });

  it("antes das 8h (parede de SP), o tick não manda nada — mesmo com compromisso hoje", async () => {
    await compromisso(HOJE_MEIO_DIA_SP);

    const sendFn = vi.fn(
      async (): Promise<Message> =>
        ({ id: "msg-1", status: "sent", external_id: "wamid.X", type: "template" }) as unknown as Message,
    );
    const resumo = await dispatchAutomationsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date(HOJE_07H_SP), // dentro da janela geral (7h–22h), antes das 8h do gatilho
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(0);
    expect(sendFn).not.toHaveBeenCalled();
    await limpa();
  });
});
