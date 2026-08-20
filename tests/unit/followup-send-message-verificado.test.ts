/**
 * `followup_turn` purpose='send_message' — o turno concluir (`runAgentTurn`
 * sem lançar) NÃO significa que uma mensagem saiu. Medido em produção: um
 * enrollment fechou como "Concluído" com ZERO linha nova em `messages`
 * (modelo/credencial silenciosamente não produziu envio). Sem esta guarda o
 * followup marcava `action_sent` e avançava mesmo assim — mentira silenciosa
 * exatamente na superfície que promete "a mensagem foi enviada".
 *
 * `runAgentTurn` é dublado (mesmo padrão de followup-canal-arquivado.test.ts):
 * só ele. O resto do handler (resolução de conversa, roteamento por purpose)
 * continua real.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runAgentTurn = vi.fn(async () => undefined);

vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
// followupTurnPayloadSchema exige UUID de verdade em followup_enrollment_id.
const ENROLLMENT = "00000000-0000-0000-0000-000000000001";
const NODE = "action-2";

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: { followup_enrollment_id: ENROLLMENT, node_id: NODE, purpose: "send_message" },
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

/** Pool que resolve a conversa (igual followup-canal-arquivado) e responde à
 *  consulta de verificação de envio conforme `enviouMensagem`. */
function fakePool(opts: { enviouMensagem: boolean }) {
  const query = vi.fn(async (sql: string) => {
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, channel_archived_at: null }] };
    }
    if (/from messages/.test(sql)) {
      return { rows: opts.enviouMensagem ? [{ "?column?": 1 }] : [] };
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

describe("followup_turn — purpose send_message só marca 'sent' com mensagem confirmada", () => {
  it("mensagem nova em `messages` ⇒ completeFollowupTurn recebe kind:'sent'", async () => {
    runAgentTurn.mockClear();
    const { pool } = fakePool({ enviouMensagem: true });
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await run(job(), pool, ctx);

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
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

  it("⭐ turno concluiu sem gerar mensagem ⇒ lança, NÃO marca 'sent' (a mentira que este teste existe pra matar)", async () => {
    runAgentTurn.mockClear();
    const { pool } = fakePool({ enviouMensagem: false });
    const completeFollowupTurn = vi.fn(async () => undefined);
    const run = criarHandler({ completeFollowupTurn } as never);

    await expect(run(job(), pool, ctx)).rejects.toThrow(/sem produzir mensagem outbound/i);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn).not.toHaveBeenCalled();
  });
});
