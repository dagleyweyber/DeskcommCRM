/**
 * `followup_turn` purpose='send_template' (nó Ação, mode 'template' — modelo
 * de mensagem pronto). Determinístico: NUNCA chama `runAgentTurn`/o modelo —
 * o texto já está escrito em `message_templates.body`. Medido em produção
 * ANTES deste conserto: mode 'template' configurado, e a mensagem que saiu
 * foi escrita livremente pela IA (o template_id nunca chegava ao envio).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type * as SendMessageModule from "@/lib/agent-engine/edge/crm/send-message";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runAgentTurn = vi.fn(async () => undefined);
const sendTurnMessage = vi.fn();

vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

vi.mock("@/lib/agent-engine/edge/crm/send-message", async (original) => {
  const real = await original<typeof SendMessageModule>();
  return { ...real, sendTurnMessage };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const ENROLLMENT = "33333333-3333-4333-8333-333333333333";
const NODE = "action-template-1";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const TEMPLATE_BODY = "Teste";

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: ENROLLMENT,
      node_id: NODE,
      purpose: "send_template",
      template_id: TEMPLATE_ID,
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

/** Pool que resolve conversa (sempre) e o modelo (conforme `existe`). */
function fakePool(opts: { existe: boolean }) {
  const query = vi.fn(async (sql: string) => {
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, channel_archived_at: null }] };
    }
    if (/from message_templates/.test(sql)) {
      return { rows: opts.existe ? [{ body: TEMPLATE_BODY }] : [] };
    }
    throw new Error(`fakePool: consulta inesperada — ${sql}`);
  });
  return { pool: { query } as never, query };
}

const ctx = { workerId: "w1" };

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import(
    "@/lib/agent-engine/agent/followup-turn"
  ));
}, 60_000);

describe("followup_turn — purpose send_template (determinístico, sem LLM)", () => {
  it("⭐ nunca chama runAgentTurn e manda o BODY exato do modelo escolhido, não texto da IA", async () => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset().mockResolvedValue({ kind: "sent", idempotencyKey: "k1", crmMessageId: "m1" });
    const { pool, query } = fakePool({ existe: true });
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await run(job(), pool, ctx);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/from message_templates/), [TEMPLATE_ID, ORG]);
    expect(sendTurnMessage).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      expect.objectContaining({ body: TEMPLATE_BODY }),
    );
    expect(completeFollowupTurn).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ organizationId: ORG, enrollmentId: ENROLLMENT, nodeId: NODE, result: { kind: "sent" } }),
    );
  });

  it("modelo apagado depois de escolhido no nó ⇒ lança, não inventa texto nem trava pra sempre", async () => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset();
    const { pool } = fakePool({ existe: false });
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await expect(run(job(), pool, ctx)).rejects.toThrow(/não encontrado/i);
    expect(sendTurnMessage).not.toHaveBeenCalled();
    expect(completeFollowupTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["blocked", { kind: "blocked", idempotencyKey: "k1" }],
    ["failed", { kind: "failed", idempotencyKey: "k1", crmMessageId: null }],
  ] as const)("outcome '%s' NÃO completa o passo — lança para o dead-letter existente cuidar", async (_label, outcome) => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset().mockResolvedValue(outcome);
    const { pool } = fakePool({ existe: true });
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await expect(run(job(), pool, ctx)).rejects.toThrow(/envio não concluiu/i);
    expect(completeFollowupTurn).not.toHaveBeenCalled();
  });
});
