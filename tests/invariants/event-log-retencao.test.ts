import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { pruneEventLog } from "@/lib/event-log/retention";
import { GOV_ORG, seedGov, sql, indexExists } from "./gov-helpers";

/**
 * Retenção de event_log (migration 0184) — parte 2 do incidente de
 * performance da RevitaFio Mossoró. A 0183 resolveu as linhas que nunca
 * saíam de `pending`; esta peça resolve a outra metade: `done`/`dead`
 * antigos, que hoje ficam no banco pra sempre.
 *
 * Mesma limitação documentada em `event-log-drain.test.ts` (harness sobe só
 * Postgres cru, sem PostgREST) — double mínimo do shape que
 * `lib/event-log/retention.ts` efetivamente usa: `.select().in().lt().limit()`
 * e `.delete().in()`, nada além disso.
 */

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function fakeAdminClient(): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => {
        const filters: string[] = [];
        let limitN: number | undefined;
        const builder = {
          in(col: string, vals: string[]) {
            filters.push(`${col} in (${vals.map(sqlStr).join(",")})`);
            return builder;
          },
          lt(col: string, val: string) {
            filters.push(`${col} < ${sqlStr(val)}`);
            return builder;
          },
          limit(n: number) {
            limitN = n;
            return builder;
          },
          then(resolve: (r: { data: unknown; error: null }) => unknown) {
            const where = filters.length ? ` where ${filters.join(" and ")}` : "";
            const lim = limitN !== undefined ? ` limit ${limitN}` : "";
            const out = sql(
              `select coalesce(json_agg(t), '[]') from (select id from public.${table}${where}${lim}) t;`,
            );
            return resolve({ data: JSON.parse(out), error: null });
          },
        };
        return builder;
      },
      delete: () => ({
        in(col: string, vals: string[]) {
          sql(`delete from public.${table} where ${col} in (${vals.map(sqlStr).join(",")});`);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

function seedRow(status: string, idadeDias: number, eventType = "test.retention_case"): string {
  const out = sql(`
    insert into public.event_log (organization_id, event_type, entity_kind, status, updated_at)
    values ('${GOV_ORG}', '${eventType}', 'test', '${status}', now() - interval '${idadeDias} days')
    returning id;
  `);
  const lines = out.split("\n");
  return lines[lines.length - 1]!;
}

function existe(id: string): boolean {
  return sql(`select exists(select 1 from public.event_log where id = '${id}');`) === "t";
}

describe("pruneEventLog — retenção de event_log (migration 0184)", () => {
  beforeAll(() => {
    seedGov();
  });

  it("o índice parcial de retenção existe (migration 0184)", () => {
    expect(indexExists("event_log_retention_idx")).toBe(true);
  });

  it("apaga done/dead mais velhos que a janela; preserva recentes e pending/processing de qualquer idade", async () => {
    const velhoDone = seedRow("done", 40);
    const velhoDead = seedRow("dead", 35);
    const recenteDone = seedRow("done", 5);
    const pendingVelho = seedRow("pending", 60);
    const processingVelho = seedRow("processing", 60);

    const stats = await pruneEventLog(fakeAdminClient(), { limit: 500, retentionDays: 30 });

    expect(stats.deleted).toBe(2);
    expect(existe(velhoDone)).toBe(false);
    expect(existe(velhoDead)).toBe(false);
    expect(existe(recenteDone)).toBe(true);
    expect(existe(pendingVelho)).toBe(true);
    expect(existe(processingVelho)).toBe(true);
  });

  it("respeita o limite do lote — não apaga tudo de uma vez", async () => {
    const a = seedRow("done", 40, "test.retention_lote");
    const b = seedRow("done", 40, "test.retention_lote");
    const c = seedRow("done", 40, "test.retention_lote");

    const stats = await pruneEventLog(fakeAdminClient(), { limit: 2, retentionDays: 30 });

    expect(stats.deleted).toBe(2);
    const restantes = [a, b, c].filter(existe);
    expect(restantes.length).toBe(1);
  });

  it("retentionDays customizado é respeitado (janela mais curta apaga mais)", async () => {
    const id = seedRow("dead", 10, "test.retention_custom");
    // Com 30 dias (padrão) não seria elegível ainda.
    const semEfeito = await pruneEventLog(fakeAdminClient(), {
      limit: 500,
      retentionDays: 30,
    });
    expect(existe(id)).toBe(true);
    void semEfeito;

    const comEfeito = await pruneEventLog(fakeAdminClient(), { limit: 500, retentionDays: 7 });
    expect(comEfeito.deleted).toBeGreaterThanOrEqual(1);
    expect(existe(id)).toBe(false);
  });
});
