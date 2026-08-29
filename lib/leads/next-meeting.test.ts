import { describe, it, expect } from "vitest";

import { proximasReunioesPorLead } from "./next-meeting";

describe("proximasReunioesPorLead", () => {
  it("⭐ meeting_scheduled sem desfecho depois → vira a próxima reunião do lead", () => {
    const mapa = proximasReunioesPorLead([
      { lead_id: "L1", type: "meeting_scheduled", payload: { scheduled_at: "2026-08-25T14:30:00-03:00" } },
    ]);
    expect(mapa.get("L1")).toBe("2026-08-25T14:30:00-03:00");
  });

  it("⭐ meeting_outcome MAIS RECENTE que o agendamento → lead some do mapa (nada pendente)", () => {
    // Ordem DESC (mais recente primeiro) — outcome veio depois do agendamento.
    const mapa = proximasReunioesPorLead([
      { lead_id: "L1", type: "meeting_outcome", payload: { scheduled_at: "2026-08-20T10:00:00-03:00" } },
      { lead_id: "L1", type: "meeting_scheduled", payload: { scheduled_at: "2026-08-20T10:00:00-03:00" } },
    ]);
    expect(mapa.has("L1")).toBe(false);
  });

  it("⭐ reagendamento (2 meeting_scheduled): o mais recente vence, não o primeiro agendado", () => {
    const mapa = proximasReunioesPorLead([
      { lead_id: "L1", type: "meeting_scheduled", payload: { scheduled_at: "2026-09-01T09:00:00-03:00" } }, // remarcado
      { lead_id: "L1", type: "meeting_scheduled", payload: { scheduled_at: "2026-08-20T09:00:00-03:00" } }, // original
    ]);
    expect(mapa.get("L1")).toBe("2026-09-01T09:00:00-03:00");
  });

  it("lead sem nenhuma atividade de reunião não aparece no mapa", () => {
    const mapa = proximasReunioesPorLead([]);
    expect(mapa.size).toBe(0);
  });

  it("vários leads, cada um com seu próprio estado (independentes)", () => {
    const mapa = proximasReunioesPorLead([
      { lead_id: "L1", type: "meeting_scheduled", payload: { scheduled_at: "2026-08-25T14:00:00-03:00" } },
      { lead_id: "L2", type: "meeting_outcome", payload: { scheduled_at: "2026-08-24T14:00:00-03:00" } },
    ]);
    expect(mapa.get("L1")).toBe("2026-08-25T14:00:00-03:00");
    expect(mapa.has("L2")).toBe(false);
  });

  it("payload sem scheduled_at (formato inesperado) não quebra — lead fica ausente do mapa", () => {
    const mapa = proximasReunioesPorLead([{ lead_id: "L1", type: "meeting_scheduled", payload: {} }]);
    expect(mapa.has("L1")).toBe(false);
  });

  it("payload null não quebra", () => {
    const mapa = proximasReunioesPorLead([{ lead_id: "L1", type: "meeting_scheduled", payload: null }]);
    expect(mapa.has("L1")).toBe(false);
  });
});
