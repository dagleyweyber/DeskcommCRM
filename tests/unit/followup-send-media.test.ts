/**
 * `followup_turn` purpose='send_media' (nó Ação, mode 'media' — áudio/imagem/
 * vídeo prontos). Determinístico: NUNCA chama `runAgentTurn`/o modelo, vai
 * direto pelo mesmo sink idempotente (`sendTurnMessage`) que o composer do
 * Inbox usa. `runAgentTurn` é dublado só para provar que este caminho não o
 * toca — a lógica real testada aqui é como o resultado de `sendTurnMessage`
 * decide completar (ou não) o passo do fluxo.
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
const ENROLLMENT = "22222222-2222-4222-8222-222222222222";
const NODE = "action-media-1";

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
      purpose: "send_media",
      media_type: "audio",
      storage_path: "org-1/followup-media/x.ogg",
      media_mime: "audio/ogg",
      caption: "oi",
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

function fakePool() {
  const query = vi.fn(async (sql: string) => {
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, channel_archived_at: null }] };
    }
    throw new Error(`fakePool: consulta inesperada — ${sql}`);
  });
  return { pool: { query } as never };
}

const ctx = { workerId: "w1" };

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import(
    "@/lib/agent-engine/agent/followup-turn"
  ));
}, 60_000);

describe("followup_turn — purpose send_media (determinístico, sem LLM)", () => {
  it("nunca chama runAgentTurn — o arquivo já está pronto, não há o que o modelo escrever", async () => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset().mockResolvedValue({ kind: "sent", idempotencyKey: "k1", crmMessageId: "m1" });
    const { pool } = fakePool();
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await run(job(), pool, ctx);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendTurnMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sent", { kind: "sent", idempotencyKey: "k1", crmMessageId: "m1" }],
    ["already_sent", { kind: "already_sent", idempotencyKey: "k1", crmMessageId: "m1" }],
    // 'queued': sessão fora do ar, mas o CRM já tem o arquivo sob custódia —
    // mesma disposição que a re-entrada determinística dá a este caso.
    ["queued", { kind: "queued", idempotencyKey: "k1", crmMessageId: "m1" }],
  ] as const)("outcome '%s' completa o passo com kind:'sent'", async (_label, outcome) => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset().mockResolvedValue(outcome);
    const { pool } = fakePool();
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await run(job(), pool, ctx);

    expect(completeFollowupTurn).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        organizationId: ORG,
        enrollmentId: ENROLLMENT,
        nodeId: NODE,
        result: { kind: "sent" },
      }),
    );
  });

  it.each([
    ["blocked", { kind: "blocked", idempotencyKey: "k1" }],
    ["failed", { kind: "failed", idempotencyKey: "k1", crmMessageId: null }],
  ] as const)("⭐ outcome '%s' NÃO completa o passo — lança para o dead-letter existente cuidar", async (_label, outcome) => {
    runAgentTurn.mockClear();
    sendTurnMessage.mockReset().mockResolvedValue(outcome);
    const { pool } = fakePool();
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await expect(run(job(), pool, ctx)).rejects.toThrow(/envio não concluiu/i);
    expect(completeFollowupTurn).not.toHaveBeenCalled();
  });
});
