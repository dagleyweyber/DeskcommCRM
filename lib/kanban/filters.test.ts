import { describe, it, expect } from "vitest";

import { applyFilters, dateRangeCutoff, filtersFromParams, filtersToParams } from "./filters";
import type { Lead } from "@/lib/types/leads";

function lead(over: Partial<Lead> & Pick<Lead, "id" | "created_at">): Lead {
  return {
    organization_id: "org-1",
    pipeline_id: "pipe-1",
    stage_id: "stage-1",
    contact_id: null,
    title: "Lead",
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1000,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    expected_close_date: null,
    closed_at: null,
    source: "whatsapp",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    updated_at: over.created_at,
    created_by_user_id: null,
    ...over,
  };
}

function params(obj: Record<string, string>): { get(key: string): string | null } {
  const sp = new URLSearchParams(obj);
  return { get: (key) => sp.get(key) };
}

describe("dateRangeCutoff", () => {
  const NOW = new Date("2026-08-29T15:30:00-03:00");

  it("⭐ 'hoje' corta na meia-noite do dia local, não 24h atrás", () => {
    const cutoff = dateRangeCutoff("hoje", NOW);
    expect(new Date(cutoff).getDate()).toBe(NOW.getDate());
    expect(new Date(cutoff).getHours()).toBe(0);
  });

  it("'7d' corta 7 dias atrás em ms", () => {
    const cutoff = dateRangeCutoff("7d", NOW);
    expect(NOW.getTime() - cutoff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("'30d' corta 30 dias atrás em ms", () => {
    const cutoff = dateRangeCutoff("30d", NOW);
    expect(NOW.getTime() - cutoff).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("filtersFromParams / filtersToParams — dateRange", () => {
  it("⭐ round-trip dos 3 presets", () => {
    for (const value of ["hoje", "7d", "30d"] as const) {
      const f = filtersFromParams(params({ date: value }));
      expect(f.dateRange).toBe(value);
      expect(filtersToParams(f)).toContain(`date=${value}`);
    }
  });

  it("valor desconhecido em ?date= vira undefined (todo período), não quebra", () => {
    const f = filtersFromParams(params({ date: "ontem" }));
    expect(f.dateRange).toBeUndefined();
  });

  it("sem dateRange, filtersToParams não adiciona o param", () => {
    expect(filtersToParams({ status: "all" })).not.toContain("date=");
  });
});

describe("applyFilters — dateRange", () => {
  const now = new Date();
  const hoje8h = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0).toISOString();
  const ontem = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const ha10dias = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const ha40dias = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

  const leads = [
    lead({ id: "hoje", created_at: hoje8h }),
    lead({ id: "ontem", created_at: ontem }),
    lead({ id: "10-dias", created_at: ha10dias }),
    lead({ id: "40-dias", created_at: ha40dias }),
  ];

  it("⭐ 'hoje' só deixa passar leads criados hoje", () => {
    const out = applyFilters(leads, { dateRange: "hoje" });
    expect(out.map((l) => l.id)).toEqual(["hoje"]);
  });

  it("⭐ '7d' inclui hoje e ontem, exclui 10 e 40 dias atrás", () => {
    const out = applyFilters(leads, { dateRange: "7d" });
    expect(out.map((l) => l.id).sort()).toEqual(["hoje", "ontem"].sort());
  });

  it("⭐ '30d' inclui até 10 dias atrás, exclui 40 dias atrás", () => {
    const out = applyFilters(leads, { dateRange: "30d" });
    expect(out.map((l) => l.id).sort()).toEqual(["hoje", "ontem", "10-dias"].sort());
  });

  it("sem dateRange, todo período passa (comportamento de hoje preservado)", () => {
    const out = applyFilters(leads, {});
    expect(out).toHaveLength(4);
  });

  it("combina com outro filtro (status) — as duas condições valem, não uma sobrepõe a outra", () => {
    const misto = [
      lead({ id: "hoje-won", created_at: hoje8h, status: "won" }),
      lead({ id: "hoje-open", created_at: hoje8h, status: "open" }),
    ];
    const out = applyFilters(misto, { dateRange: "hoje", status: "open" });
    expect(out.map((l) => l.id)).toEqual(["hoje-open"]);
  });
});
