import { describe, it, expect } from "vitest";
import {
  moveLeadSchema,
  loseLeadSchema,
  bulkLeadActionSchema,
  objectionSchema,
  formatLostReason,
  scheduleMeetingSchema,
  meetingOutcomeSchema,
} from "./leads";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

describe("moveLeadSchema", () => {
  it("accepts a valid move payload", () => {
    const r = moveLeadSchema.safeParse({
      stage_id: UUID,
      position_in_stage: 1.5,
      expected_updated_at: "2026-04-28T10:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-uuid stage_id", () => {
    const r = moveLeadSchema.safeParse({
      stage_id: "not-uuid",
      position_in_stage: 1,
      expected_updated_at: "2026-04-28T10:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-finite position", () => {
    const r = moveLeadSchema.safeParse({
      stage_id: UUID,
      position_in_stage: Number.POSITIVE_INFINITY,
      expected_updated_at: "2026-04-28T10:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});

describe("loseLeadSchema", () => {
  it("requires lost_reason", () => {
    const r = loseLeadSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects empty lost_reason", () => {
    const r = loseLeadSchema.safeParse({ lost_reason: "" });
    expect(r.success).toBe(false);
  });

  it("accepts a non-empty reason", () => {
    const r = loseLeadSchema.safeParse({ lost_reason: "Sem orçamento" });
    expect(r.success).toBe(true);
  });
});

describe("formatLostReason", () => {
  it("traduz código canônico pro rótulo PT-BR", () => {
    expect(formatLostReason("price")).toBe("Preço");
  });

  it("texto livre (motivo extra do pipeline) passa direto — já é o rótulo", () => {
    expect(formatLostReason("Mudou de cidade")).toBe("Mudou de cidade");
  });
});

describe("objectionSchema", () => {
  it("accepts a canonical reason without a note", () => {
    const r = objectionSchema.safeParse({ reason: "price" });
    expect(r.success).toBe(true);
  });

  it("accepts a canonical reason with a note", () => {
    const r = objectionSchema.safeParse({ reason: "other", note: "Achou o valor alto" });
    expect(r.success).toBe(true);
  });

  it("⭐ rejects a reason outside CANONICAL_OBJECTIONS — não é texto livre como lost_reason", () => {
    const r = objectionSchema.safeParse({ reason: "cancelled_by_store" });
    expect(r.success).toBe(false);
  });

  it("rejects missing reason", () => {
    const r = objectionSchema.safeParse({ note: "sem motivo" });
    expect(r.success).toBe(false);
  });

  it("rejects note acima de 500 caracteres", () => {
    const r = objectionSchema.safeParse({ reason: "price", note: "x".repeat(501) });
    expect(r.success).toBe(false);
  });
});

describe("scheduleMeetingSchema", () => {
  it("aceita ISO-8601 com offset", () => {
    const r = scheduleMeetingSchema.safeParse({ scheduled_at: "2026-08-25T14:30:00-03:00" });
    expect(r.success).toBe(true);
  });

  it("⭐ rejeita data sem offset — mesma exigência de outras datas da API", () => {
    const r = scheduleMeetingSchema.safeParse({ scheduled_at: "2026-08-25T14:30:00" });
    expect(r.success).toBe(false);
  });

  it("rejeita string que não é data", () => {
    const r = scheduleMeetingSchema.safeParse({ scheduled_at: "amanhã" });
    expect(r.success).toBe(false);
  });
});

describe("meetingOutcomeSchema", () => {
  it("aceita 'attended'", () => {
    expect(meetingOutcomeSchema.safeParse({ outcome: "attended" }).success).toBe(true);
  });

  it("aceita 'no_show'", () => {
    expect(meetingOutcomeSchema.safeParse({ outcome: "no_show" }).success).toBe(true);
  });

  it("rejeita valor fora do vocabulário fechado", () => {
    expect(meetingOutcomeSchema.safeParse({ outcome: "maybe" }).success).toBe(false);
  });
});

describe("bulkLeadActionSchema", () => {
  it("accepts a valid move bulk", () => {
    const r = bulkLeadActionSchema.safeParse({
      action: "move",
      lead_ids: [UUID],
      params: { stage_id: UUID2, position_in_stage: 1 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects more than 50 lead_ids", () => {
    const ids = Array.from({ length: 51 }, () => UUID);
    const r = bulkLeadActionSchema.safeParse({
      action: "delete",
      lead_ids: ids,
      params: {},
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty lead_ids", () => {
    const r = bulkLeadActionSchema.safeParse({
      action: "delete",
      lead_ids: [],
      params: {},
    });
    expect(r.success).toBe(false);
  });

  it("accepts assign with null owner", () => {
    const r = bulkLeadActionSchema.safeParse({
      action: "assign",
      lead_ids: [UUID],
      params: { owner_user_id: null },
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown action", () => {
    const r = bulkLeadActionSchema.safeParse({
      action: "explode",
      lead_ids: [UUID],
      params: {},
    });
    expect(r.success).toBe(false);
  });
});
