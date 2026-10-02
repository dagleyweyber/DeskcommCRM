import { describe, expect, it } from "vitest";

import { mesclaEnriquecimentos } from "./route";
import type { Lead } from "@/lib/types/leads";

/**
 * O GET do board rodava as 5 enriquecedoras (dono/score/conversa/reunião/
 * próxima ação) em CADEIA — 6 round trips sequenciais, nenhum deles
 * dependendo do campo que o anterior escreveu. `mesclaEnriquecimentos` é a
 * função pura que permitiu rodá-las em paralelo: pega o resultado de cada
 * uma (uma cópia INTEIRA da lista, com só o seu campo a mais) e funde de
 * volta numa lista só, por id. Este teste prova que a fusão dá o MESMO
 * resultado que a cadeia sequencial dava — sem precisar montar um Supabase
 * de mentira.
 */
function lead(over: Partial<Lead> & { id: string }): Lead {
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
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by_user_id: null,
    ...over,
  };
}

describe("mesclaEnriquecimentos", () => {
  it("⭐ funde os 5 campos de volta no MESMO lead, cada um vindo de um resultado diferente", () => {
    const base = [lead({ id: "l1" }), lead({ id: "l2" })];

    const owner = [
      lead({ id: "l1", owner_agent: { id: "a1", name: "Mariana", version_number: 3 } }),
      lead({ id: "l2" }), // sem dono — não tinha owner_kind='ai'
    ];
    const score = [
      lead({ id: "l1" }), // sem sinal suficiente
      lead({ id: "l2", score: { probability: 0.8, reason: "r", band: "quente", factors: [], at: null } }),
    ];
    const conversa = [
      lead({ id: "l1", conversa: { id: "c1", preview: "oi", last_message_at: null, unread: 2 } }),
      lead({ id: "l2" }),
    ];
    const reuniao = [lead({ id: "l1" }), lead({ id: "l2", next_meeting_at: "2026-10-10T12:00:00.000Z" })];
    const acao = [
      lead({ id: "l1", next_action: { label: "Ligar", seq: 1, proposed_at: "2026-10-01T00:00:00.000Z" } }),
      lead({ id: "l2" }),
    ];

    const out = mesclaEnriquecimentos(base, { owner, score, conversa, reuniao, acao });

    const l1 = out.find((l) => l.id === "l1")!;
    expect(l1.owner_agent).toEqual({ id: "a1", name: "Mariana", version_number: 3 });
    expect(l1.score).toBeUndefined();
    expect(l1.conversa).toEqual({ id: "c1", preview: "oi", last_message_at: null, unread: 2 });
    expect(l1.next_meeting_at).toBeUndefined();
    expect(l1.next_action).toEqual({ label: "Ligar", seq: 1, proposed_at: "2026-10-01T00:00:00.000Z" });

    const l2 = out.find((l) => l.id === "l2")!;
    expect(l2.owner_agent).toBeUndefined();
    expect(l2.score).toEqual({ probability: 0.8, reason: "r", band: "quente", factors: [], at: null });
    expect(l2.conversa).toBeUndefined();
    expect(l2.next_meeting_at).toBe("2026-10-10T12:00:00.000Z");
    expect(l2.next_action).toBeUndefined();
  });

  it("lead sem NENHUM enriquecimento sai idêntico ao que entrou, nenhum campo extra", () => {
    const base = [lead({ id: "l1", title: "Original" })];
    const out = mesclaEnriquecimentos(base, {
      owner: base,
      score: base,
      conversa: base,
      reuniao: base,
      acao: base,
    });
    expect(out).toEqual(base);
  });

  it("lista vazia não quebra", () => {
    expect(mesclaEnriquecimentos([], { owner: [], score: [], conversa: [], reuniao: [], acao: [] })).toEqual([]);
  });
});
