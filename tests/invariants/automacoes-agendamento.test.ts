import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { dispatchAutomationsTick } from "@/lib/automations/dispatch";
import type { Message } from "@/lib/types/messaging";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * `fn_due_appointment_reminders` (migration 0169) + o ciclo completo do
 * despachante, contra Postgres real — mesma filosofia de
 * `campanhas-despacho.test.ts`: `sendMessageHandler` é dublê, o resto
 * (RPC, `ensureConversation`, gravação de dedup) roda código de produção.
 *
 * `crm_lead_activities` é append-only: cada cenário grava uma linha NOVA
 * (nunca UPDATE), a mesma forma que `POST .../meetings/schedule` grava de
 * verdade — reagendar É emitir de novo.
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
let lead = "";

async function novaAtividade(
  leadId: string,
  contactId: string,
  type: "meeting_scheduled" | "meeting_outcome",
  scheduledAtIso: string | null,
  performedAtIso: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_lead_activities
       (organization_id, lead_id, contact_id, source_module, type, payload, performed_at)
     values ($1, $2, $3, 'test', $4, $5::jsonb, $6)
     returning id`,
    [
      ORG,
      leadId,
      contactId,
      type,
      scheduledAtIso ? JSON.stringify({ scheduled_at: scheduledAtIso }) : "{}",
      performedAtIso,
    ],
  );
  return rows[0]!.id;
}

async function registraEnvio(automationId: string, occurrenceKey: string, leadId: string, contactId: string) {
  await pool.query(
    `insert into whatsapp_template_automation_sends
       (automation_id, organization_id, lead_id, contact_id, occurrence_key, status)
     values ($1, $2, $3, $4, $5, 'sent')`,
    [automationId, ORG, leadId, contactId, occurrenceKey],
  );
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
    `insert into contacts (organization_id, display_name, phone_number, source)
     values ($1, 'Paciente Teste', '+5511900000098', 'whatsapp') returning id`,
    [ORG],
  );
  contato = c[0]!.id;

  // A organização já NASCE com funil padrão — `fn_seed_default_pipeline_for_org`
  // (mesmo trigger que `nascimento-do-lead.test.ts` documenta). Inserir um
  // segundo `is_default = true` bateria em `uniq_crm_pipelines_org_default`;
  // este teste não é sobre qual é o funil de entrada, só precisa de um
  // estágio aberto válido pra pendurar o lead.
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
  const stageId = s[0]!.id;

  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, source)
     values ($1, $2, $3, $4, 'Paciente Teste', 'whatsapp') returning id`,
    [ORG, pipelineId, stageId, contato],
  );
  lead = l[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_B]]);
  await pool.end();
});

/** 11:00Z = 08:00 em América/São_Paulo (UTC-3, sem horário de verão desde 2019). */
const HOJE_08H_SP = "2026-03-10T11:00:00.000Z";
const HOJE_09H_SP = "2026-03-10T12:00:00.000Z";
const HOJE_MEIO_DIA_SP = "2026-03-10T15:00:00.000Z";

describe("fn_due_appointment_reminders", () => {
  it("⭐ agendamento hoje, sem envio prévio → aparece", async () => {
    const atividadeId = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);

    const { rows } = await pool.query(
      "select * from fn_due_appointment_reminders($1, $2, $3)",
      [ORG, AUTOMATION, HOJE_MEIO_DIA_SP],
    );
    expect(rows.map((r) => r.activity_id)).toContain(atividadeId);

    // limpeza pro próximo caso não herdar esta atividade como "a mais recente"
    await pool.query("delete from crm_lead_activities where id = $1", [atividadeId]);
  });

  it("⭐ mesmo agendamento, já registrado em whatsapp_template_automation_sends → some", async () => {
    const atividadeId = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);
    await registraEnvio(AUTOMATION, atividadeId, lead, contato);

    const { rows } = await pool.query(
      "select * from fn_due_appointment_reminders($1, $2, $3)",
      [ORG, AUTOMATION, HOJE_MEIO_DIA_SP],
    );
    expect(rows.map((r) => r.activity_id)).not.toContain(atividadeId);

    await pool.query("delete from whatsapp_template_automation_sends where occurrence_key = $1", [atividadeId]);
    await pool.query("delete from crm_lead_activities where id = $1", [atividadeId]);
  });

  it("⭐ reagendado (nova linha meeting_scheduled): aparece de novo com activity_id NOVO, mesmo com o antigo já enviado", async () => {
    const antiga = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);
    await registraEnvio(AUTOMATION, antiga, lead, contato);

    // reagendou pra mais tarde no mesmo dia — linha NOVA, performed_at mais recente
    const nova = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_09H_SP);

    const { rows } = await pool.query(
      "select * from fn_due_appointment_reminders($1, $2, $3)",
      [ORG, AUTOMATION, HOJE_MEIO_DIA_SP],
    );
    const ids = rows.map((r) => r.activity_id);
    expect(ids).toContain(nova);
    expect(ids).not.toContain(antiga);

    await pool.query("delete from whatsapp_template_automation_sends where occurrence_key = $1", [antiga]);
    await pool.query("delete from crm_lead_activities where id = any($1)", [[antiga, nova]]);
  });

  it("meeting_outcome mais recente que o meeting_scheduled → some (já resolvido)", async () => {
    const agendado = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);
    const resolvido = await novaAtividade(lead, contato, "meeting_outcome", null, HOJE_09H_SP);

    const { rows } = await pool.query(
      "select * from fn_due_appointment_reminders($1, $2, $3)",
      [ORG, AUTOMATION, HOJE_MEIO_DIA_SP],
    );
    expect(rows.map((r) => r.activity_id)).not.toContain(agendado);

    await pool.query("delete from crm_lead_activities where id = any($1)", [[agendado, resolvido]]);
  });

  it("⭐ isolamento entre organizações — automação de outra org nunca vê o agendamento desta", async () => {
    const atividadeId = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);

    const { rows } = await pool.query(
      "select * from fn_due_appointment_reminders($1, $2, $3)",
      [ORG_B, AUTOMATION, HOJE_MEIO_DIA_SP],
    );
    expect(rows).toHaveLength(0);

    await pool.query("delete from crm_lead_activities where id = $1", [atividadeId]);
  });
});

describe("dispatchAutomationsTick — ciclo completo contra Postgres real", () => {
  it("⭐ um tick às 8h manda o lembrete e grava o dedup; um segundo tick no mesmo dia não duplica", async () => {
    const atividadeId = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);

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
      "select status, external_id, occurrence_key from whatsapp_template_automation_sends where automation_id = $1",
      [AUTOMATION],
    );
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ status: "sent", external_id: "wamid.LEMBRETE", occurrence_key: atividadeId });

    // Segundo tick, mesmo dia — não reenvia a mesma ocorrência.
    const segundo = await dispatchAutomationsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date(HOJE_09H_SP),
      timeBudgetMs: 5000,
    });
    expect(segundo.sent).toBe(0);
    expect(sendFn).toHaveBeenCalledTimes(1);

    await pool.query("delete from whatsapp_template_automation_sends where automation_id = $1", [AUTOMATION]);
    await pool.query("delete from crm_lead_activities where id = $1", [atividadeId]);
  });

  it("antes das 8h (parede de SP), o tick não manda nada — mesmo com agendamento hoje", async () => {
    const atividadeId = await novaAtividade(lead, contato, "meeting_scheduled", HOJE_MEIO_DIA_SP, HOJE_08H_SP);

    const sendFn = vi.fn(
      async (): Promise<Message> =>
        ({ id: "msg-1", status: "sent", external_id: "wamid.X", type: "template" }) as unknown as Message,
    );
    const resumo = await dispatchAutomationsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-03-10T10:00:00.000Z"), // 07:00 em SP — dentro da janela geral, antes das 8h do gatilho
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(0);
    expect(sendFn).not.toHaveBeenCalled();

    await pool.query("delete from crm_lead_activities where id = $1", [atividadeId]);
  });
});
