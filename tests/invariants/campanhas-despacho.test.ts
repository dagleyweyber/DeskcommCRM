import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { dispatchCampaignsTick } from "@/lib/campaigns/dispatch";
import type { Message } from "@/lib/types/messaging";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * UM TICK DO DESPACHANTE, contra Postgres real.
 *
 * `sendMessageHandler` é injetado por dublê (`sendMessageFn`) — a chamada
 * real à Meta é responsabilidade do adapter, já provada nos testes DELE
 * (`tests/unit/channel-adapter-meta.test.ts`). O que se prova aqui é a
 * ORQUESTRAÇÃO: pegar `pending`, marcar `sending`→`sent`/`failed`, respeitar
 * janela/limite diário (`lib/automation/throttle.ts`, não reimplementado),
 * e fechar a campanha quando não sobra ninguém.
 *
 * `ensureConversation` roda de VERDADE (é só Postgres, sem rede) — é código
 * de produção rodando, não um SQL escrito ao lado que prova o banco em vez
 * do código, mesma filosofia de `pgComoSupabase`.
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

const ORG = "dc0ca11e-0000-4000-8000-000000000001";
const SESSION = "dc0ca11e-0000-4000-8000-000000000002";

let contatoA = "";
let contatoB = "";

async function novaCampanha(status: "queued" | "running" = "queued") {
  const { rows } = await pool.query<{ id: string }>(
    `insert into whatsapp_campaigns
       (organization_id, name, channel_session_id, template_name, template_language,
        variable_mapping, audience_filter, status, total_recipients)
     values ($1, 'Campanha de teste', $2, 'oferta', 'pt_BR', '{}'::jsonb, '{"kind":"tag","tag":"x"}'::jsonb, $3, 2)
     returning id`,
    [ORG, SESSION, status],
  );
  return rows[0]!.id;
}

async function novoDestinatario(campaignId: string, contactId: string, valores: Record<string, string>) {
  await pool.query(
    `insert into whatsapp_campaign_recipients (campaign_id, organization_id, contact_id, resolved_values, status)
     values ($1, $2, $3, $4, 'pending')`,
    [campaignId, ORG, contactId, JSON.stringify(valores)],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-campanhas-despacho', 'Despacho LTDA', 'Despacho') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000000', '999', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, channel_session_id, name, language, status, components, contract_hash)
     values ($1, '999', $2, 'oferta', 'pt_BR', 'APPROVED', $3::jsonb, 'hash-teste')`,
    [ORG, SESSION, JSON.stringify([{ type: "BODY", text: "Olá {{1}}, aproveite!" }])],
  );

  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source) values
       ($1, 'Contato A', '+5511900000001', 'whatsapp'),
       ($1, 'Contato B', '+5511900000002', 'whatsapp')
     returning id`,
    [ORG],
  );
  contatoA = rows[0]!.id;
  contatoB = rows[1]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

/** Dublê de `sendMessageHandler` — sempre "envia com sucesso". */
function sendFnSucesso() {
  return vi.fn(
    async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> =>
      ({ id: "msg-1", status: "sent", external_id: "wamid.FAKE", type: "template" }) as unknown as Message,
  );
}

describe("um tick processa os pendentes e completa a campanha", () => {
  it("⭐ manda pra cada pendente com os valores certos, e fecha `completed` sem sobrar nada", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });
    await novoDestinatario(campaignId, contatoB, { "1": "Bia" });

    const sendFn = sendFnSucesso();
    const resumo = await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T14:00:00Z"), // dentro da janela 7h-22h
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(2);
    expect(sendFn).toHaveBeenCalledTimes(2);
    const chamadas = sendFn.mock.calls.map((c) => (c[2] as { template_values: Record<string, string> }).template_values);
    expect(chamadas).toEqual(expect.arrayContaining([{ "1": "Ana" }, { "1": "Bia" }]));

    const { rows: destinatarios } = await pool.query<{ status: string; external_id: string | null }>(
      "select status, external_id from whatsapp_campaign_recipients where campaign_id = $1",
      [campaignId],
    );
    expect(destinatarios.every((d) => d.status === "sent" && d.external_id === "wamid.FAKE")).toBe(true);

    const { rows: campanha } = await pool.query<{ status: string; sent_count: number; completed_at: string | null }>(
      "select status, sent_count, completed_at from whatsapp_campaigns where id = $1",
      [campaignId],
    );
    expect(campanha[0]).toMatchObject({ status: "completed", sent_count: 2 });
    expect(campanha[0]!.completed_at).not.toBeNull();

    // A conversa foi criada de verdade — `ensureConversation` rodando código
    // de produção, não um stub.
    const { rows: conversas } = await pool.query(
      "select count(*)::int as n from conversations where organization_id = $1 and channel_session_id = $2",
      [ORG, SESSION],
    );
    expect(conversas[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("envio que falha marca `failed` no destinatário e NÃO trava os outros", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });
    await novoDestinatario(campaignId, contatoB, { "1": "Bia" });

    let chamada = 0;
    const sendFn = vi.fn(async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> => {
      chamada += 1;
      if (chamada === 1) throw new Error("meta_500: instabilidade");
      return { id: "msg-2", status: "sent", external_id: "wamid.OK", type: "template" } as unknown as Message;
    });

    const resumo = await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T14:00:00Z"),
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(1);
    expect(resumo.failed).toBe(1);

    const { rows } = await pool.query<{ status: string; error_message: string | null }>(
      "select status, error_message from whatsapp_campaign_recipients where campaign_id = $1 order by created_at",
      [campaignId],
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]!.error_message).toContain("instabilidade");
    expect(rows[1]).toMatchObject({ status: "sent" });
  });
});

describe("fora da janela de horário, o tick não manda nada", () => {
  it("campanha `queued` vira `running` mas nenhum destinatário sai de `pending`", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });

    const sendFn = sendFnSucesso();
    await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T03:00:00Z"), // 3h da manhã — fora da janela
      timeBudgetMs: 5000,
    });

    expect(sendFn).not.toHaveBeenCalled();
    const { rows } = await pool.query<{ status: string }>(
      "select status from whatsapp_campaign_recipients where campaign_id = $1",
      [campaignId],
    );
    expect(rows[0]!.status).toBe("pending");

    const { rows: campanha } = await pool.query<{ status: string }>(
      "select status from whatsapp_campaigns where id = $1",
      [campaignId],
    );
    expect(campanha[0]!.status).toBe("running");
  });
});
