import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 0199 — o lembrete de agendamento sabe QUAL serviço.
 *
 * Achado com a B'Laser Parnamirim: dois serviços (depilação a laser, estética corporal),
 * dois modelos de mensagem. Antes, toda automação ativa mandava o seu modelo para TODO
 * agendamento do dia — o cliente de estética recebia o texto da depilação.
 *
 * As atividades `meeting_scheduled` são gravadas como a Agenda grava
 * (`source_module = 'agenda.agendamentos'`, `source_id` = id do compromisso).
 *
 * Desde a 0201 a função lê o COMPROMISSO direto (não a atividade) e devolve o id
 * dele em `activity_id` — o filtro por serviço desta migration continua o mesmo.
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

const ORG = "a90da000-0000-4000-8000-0000000000a1";
const SESSION = "a90da000-0000-4000-8000-0000000000a2";
const LASER = "a90da000-0000-4000-8000-0000000000b1";
const ESTETICA = "a90da000-0000-4000-8000-0000000000b2";
const A_TODOS = "a90da000-0000-4000-8000-0000000000c1";
const A_LASER = "a90da000-0000-4000-8000-0000000000c2";
const A_ESTETICA = "a90da000-0000-4000-8000-0000000000c3";

/** 15:00Z = 12:00 em São Paulo. */
const AGORA = "2026-03-10T15:00:00.000Z";
/** O compromisso é às 15h (SP): ainda vai acontecer quando o lembrete é avaliado ao meio-dia. */
const HOJE_15H = "2026-03-10T18:00:00.000Z";

let pipelineId = "";
let stageId = "";
let seq = 0;

/**
 * Contato + lead + compromisso (opcional) + atividade `meeting_scheduled`. Devolve o id
 * do COMPROMISSO (é o que a função devolve desde a 0201) — ou o da atividade, quando não
 * há compromisso (caso legado).
 */
async function agendamento(opts: {
  servico: string | null;
  status?: "pending" | "cancelled";
  daAgenda?: boolean;
}): Promise<string> {
  seq += 1;
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source)
     values ($1, $2, $3, 'whatsapp') returning id`,
    [ORG, `Paciente ${seq}`, `+55119000${String(seq).padStart(5, "0")}`],
  );
  const contato = c[0]!.id;
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, source)
     values ($1, $2, $3, $4, $5, 'whatsapp') returning id`,
    [ORG, pipelineId, stageId, contato, `Paciente ${seq}`],
  );
  const lead = l[0]!.id;

  let sourceModule = "test";
  let sourceId: string | null = null;
  if (opts.daAgenda !== false) {
    const cancelado = opts.status === "cancelled";
    const { rows: a } = await pool.query<{ id: string }>(
      `insert into calendar_appointments
         (organization_id, event_type_id, title, starts_at, ends_at, status, contact_id,
          cancelled_at, cancellation_reason)
       values ($1, $2, 'Consulta', $3, $3::timestamptz + interval '30 minutes', $4, $5,
               $6, $7)
       returning id`,
      [
        ORG,
        opts.servico,
        HOJE_15H,
        opts.status ?? "pending",
        contato,
        cancelado ? AGORA : null,
        cancelado ? "teste" : null,
      ],
    );
    sourceModule = "agenda.agendamentos";
    sourceId = a[0]!.id;
  }

  const { rows: act } = await pool.query<{ id: string }>(
    `insert into crm_lead_activities
       (organization_id, lead_id, contact_id, source_module, source_id, type, payload, performed_at)
     values ($1, $2, $3, $4, $5, 'meeting_scheduled', $6::jsonb, $7)
     returning id`,
    [ORG, lead, contato, sourceModule, sourceId, JSON.stringify({ scheduled_at: HOJE_15H }), "2026-03-10T11:00:00.000Z"],
  );
  return sourceId ?? act[0]!.id;
}

async function devidos(automacao: string): Promise<string[]> {
  const { rows } = await pool.query<{ activity_id: string }>(
    "select activity_id from fn_due_appointment_reminders($1, $2, $3)",
    [ORG, automacao, AGORA],
  );
  return rows.map((r) => r.activity_id);
}

async function ativa(id: string, ligada: boolean) {
  await pool.query("update whatsapp_template_automations set status = $2 where id = $1", [
    id,
    ligada ? "active" : "paused",
  ]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-automacao-servico', 'Servico LTDA', 'Servico')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000199', '999', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into calendar_event_types (id, organization_id, name, slug) values
       ($1, $3, 'Depilação a Laser', 'laser'),
       ($2, $3, 'Estética Corporal', 'estetica')`,
    [LASER, ESTETICA, ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    "select id from crm_pipelines where organization_id = $1 and is_default = true",
    [ORG],
  );
  pipelineId = p[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `select id from crm_stages
      where organization_id = $1 and pipeline_id = $2
        and is_archived = false and is_won = false and is_lost = false
      order by position asc limit 1`,
    [ORG, pipelineId],
  );
  stageId = s[0]!.id;

  // Todas nascem PAUSADAS; cada teste liga o que precisa (o índice único só vale p/ ativas).
  for (const [id, nome, servico] of [
    [A_TODOS, 'Todos os serviços', null],
    [A_LASER, 'Laser', LASER],
    [A_ESTETICA, 'Estética', ESTETICA],
  ] as const) {
    await pool.query(
      `insert into whatsapp_template_automations
         (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language,
          variable_mapping, status, event_type_id)
       values ($1, $2, $3, 'appointment_reminder', $4, 'modelo', 'pt_BR', '{}'::jsonb, 'paused', $5)`,
      [id, ORG, nome, SESSION, servico],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("fn_due_appointment_reminders — filtro por serviço (0199)", () => {
  it("⭐ cada automação recebe SÓ os agendamentos do seu serviço", async () => {
    await ativa(A_LASER, true);
    await ativa(A_ESTETICA, true);
    const laser = await agendamento({ servico: LASER });
    const estetica = await agendamento({ servico: ESTETICA });

    expect(await devidos(A_LASER)).toEqual([laser]);
    expect(await devidos(A_ESTETICA)).toEqual([estetica]);

    await ativa(A_LASER, false);
    await ativa(A_ESTETICA, false);
  });

  it("⭐ 'todos os serviços' pega tudo quando nenhum serviço tem automação própria", async () => {
    await ativa(A_TODOS, true);
    const laser = await agendamento({ servico: LASER });
    const estetica = await agendamento({ servico: ESTETICA });

    const ids = await devidos(A_TODOS);
    expect(ids).toContain(laser);
    expect(ids).toContain(estetica);

    await ativa(A_TODOS, false);
  });

  it("⭐ o específico vence: 'todos' NÃO pega o serviço que tem automação própria ativa", async () => {
    await ativa(A_TODOS, true);
    await ativa(A_LASER, true);
    const laser = await agendamento({ servico: LASER });
    const estetica = await agendamento({ servico: ESTETICA });

    const ids = await devidos(A_TODOS);
    expect(ids).not.toContain(laser); // evita as duas mensagens para o mesmo cliente
    expect(ids).toContain(estetica); // estética não tem automação própria → cai em 'todos'

    // pausada a do laser, 'todos' volta a cobrir o laser
    await ativa(A_LASER, false);
    expect(await devidos(A_TODOS)).toContain(laser);

    await ativa(A_TODOS, false);
  });

  it("⭐ agendamento CANCELADO na Agenda não recebe lembrete", async () => {
    await ativa(A_LASER, true);
    await ativa(A_TODOS, false);
    const cancelado = await agendamento({ servico: LASER, status: "cancelled" });
    expect(await devidos(A_LASER)).not.toContain(cancelado);

    await ativa(A_LASER, false);
    await ativa(A_TODOS, true);
    expect(await devidos(A_TODOS)).not.toContain(cancelado);
    await ativa(A_TODOS, false);
  });

  it("atividade sem compromisso na Agenda (diálogo antigo do Kanban) não dispara mais (0201: a fonte é a Agenda)", async () => {
    const legado = await agendamento({ servico: null, daAgenda: false });

    await ativa(A_LASER, true);
    expect(await devidos(A_LASER)).not.toContain(legado);
    await ativa(A_LASER, false);

    await ativa(A_TODOS, true);
    expect(await devidos(A_TODOS)).not.toContain(legado);
    await ativa(A_TODOS, false);
  });

  it("compromisso da Agenda sem serviço só casa com 'todos'", async () => {
    const semServico = await agendamento({ servico: null });

    await ativa(A_ESTETICA, true);
    expect(await devidos(A_ESTETICA)).not.toContain(semServico);
    await ativa(A_ESTETICA, false);

    await ativa(A_TODOS, true);
    expect(await devidos(A_TODOS)).toContain(semServico);
    await ativa(A_TODOS, false);
  });
});

describe("uniq_automacao_ativa_por_servico_e_momento (0199 → 0201)", () => {
  it("⭐ duas ativas do MESMO serviço não coexistem (trava contra envio em dobro)", async () => {
    await ativa(A_LASER, true);
    const outra = "a90da000-0000-4000-8000-0000000000c9";
    await expect(
      pool.query(
        `insert into whatsapp_template_automations
           (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language,
            variable_mapping, status, event_type_id)
         values ($1, $2, 'Laser 2', 'appointment_reminder', $3, 'modelo', 'pt_BR', '{}'::jsonb, 'active', $4)`,
        [outra, ORG, SESSION, LASER],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await ativa(A_LASER, false);
  });

  it("serviços diferentes e 'todos' podem estar ativos juntos; pausadas não contam", async () => {
    await ativa(A_TODOS, true);
    await ativa(A_LASER, true);
    await ativa(A_ESTETICA, true);
    const { rows } = await pool.query(
      "select count(*)::int as n from whatsapp_template_automations where organization_id = $1 and status = 'active'",
      [ORG],
    );
    expect(rows[0].n).toBe(3);
    await ativa(A_TODOS, false);
    await ativa(A_LASER, false);
    await ativa(A_ESTETICA, false);
  });

  it("⭐ (0201) mesmo serviço em MOMENTOS diferentes coexiste: confirmação 1 dia antes + lembrete no dia", async () => {
    await ativa(A_LASER, true); // no dia, às 8h
    const confirmacao = "a90da000-0000-4000-8000-0000000000c8";
    await pool.query(
      `insert into whatsapp_template_automations
         (id, organization_id, name, trigger_kind, channel_session_id, template_name, template_language,
          variable_mapping, status, event_type_id, timing_kind, timing_value, confirm_button_text)
       values ($1, $2, 'Laser — confirmação', 'appointment_reminder', $3, 'modelo', 'pt_BR', '{}'::jsonb,
               'active', $4, 'days_before', 1, 'Confirmo')`,
      [confirmacao, ORG, SESSION, LASER],
    );
    const { rows } = await pool.query(
      "select count(*)::int as n from whatsapp_template_automations where organization_id = $1 and status = 'active' and event_type_id = $2",
      [ORG, LASER],
    );
    expect(rows[0].n).toBe(2);
    await pool.query("delete from whatsapp_template_automations where id = $1", [confirmacao]);
    await ativa(A_LASER, false);
  });
});
