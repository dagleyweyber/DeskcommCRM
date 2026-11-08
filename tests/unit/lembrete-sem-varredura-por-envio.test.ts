/**
 * Guarda estrutural da 0212: a consulta de "quem está devido" não pode voltar a
 * comparar CADA candidato com CADA envio já feito lendo `crm_lead_activities`.
 *
 * Esse formato levou a consulta a ~39 s no B'Laser Parnamirim (3.291 compromissos,
 * 147 envios), acima dos 8 s que o PostgREST aceita — e a confirmação parou sem erro.
 * O desempenho em si é medido em produção/EXPLAIN; este teste só impede o retorno
 * do formato quadrático, e as invariantes de `automacoes-agendamento` guardam o resultado.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = process.cwd();
/** Sem os comentários `--`: a migration explica o formato proibido, e o texto da explicação não conta. */
const semComentarios = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

const migration = semComentarios(
  readFileSync(
    join(raiz, "supabase/migrations/20261106130000_0212_lembrete_sem_varredura_por_envio.sql"),
    "utf8",
  ),
);
const baseline = semComentarios(readFileSync(join(raiz, "supabase/baseline.sql"), "utf8"));

/** A ÚLTIMA definição da função no baseline é a que vale (apêndices são cumulativos). */
function ultimaDefinicao(sql: string): string {
  const inicio = sql.lastIndexOf("create or replace function public.fn_due_appointment_reminders(");
  const fim = sql.indexOf("revoke all on function public.fn_due_appointment_reminders", inicio);
  return sql.slice(inicio, fim);
}

const QUADRATICO = /occurrence_key\s+in\s*\(\s*select\s+act\.id::text/i;

describe("fn_due_appointment_reminders (0212)", () => {
  it("⭐ a migration calcula as chaves de envio uma vez (CTE), não por candidato", () => {
    expect(migration).toMatch(/chaves_enviadas as \(/);
    expect(migration).toMatch(/chaves_antigas as \(/);
    expect(migration).not.toMatch(QUADRATICO);
  });

  it("⭐ a definição que vale no baseline é a nova", () => {
    const def = ultimaDefinicao(baseline);
    expect(def).toMatch(/chaves_enviadas as \(/);
    expect(def).not.toMatch(QUADRATICO);
  });

  it("continua fechada para anon/authenticated e aberta só ao service_role", () => {
    expect(migration).toMatch(/revoke all on function public\.fn_due_appointment_reminders\(uuid, uuid, timestamptz\) from public;/);
    expect(migration).toMatch(/from anon, authenticated;/);
    expect(migration).toMatch(/to service_role;/);
  });
});
