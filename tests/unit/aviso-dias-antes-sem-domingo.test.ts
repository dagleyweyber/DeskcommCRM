/**
 * Guarda da 0213: o aviso "X dias antes" nunca é devido no domingo — vai para o sábado.
 *
 * Caso real (B'Laser Parnamirim, 2026-11-07): a confirmação "1 dia antes às 8h" de um
 * agendamento de segunda saía no domingo às 8h; a clínica quer a agenda de segunda
 * confirmada no sábado. O comportamento em si foi medido no banco; este teste impede
 * a regra de sumir da migration ou de ficar diferente do que o kit self-host aplica.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = process.cwd();
// CRLF vira LF ANTES de tirar os comentários: com `\r` no texto, o `^` multilinha do JS casa
// entre `\r` e `\n` e deixa um `\r` solto no fim da linha anterior (o baseline é CRLF).
const semComentarios = (sql: string) => sql.replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");

const migration = semComentarios(
  readFileSync(join(raiz, "supabase/migrations/20261107120000_0213_aviso_dias_antes_sem_domingo.sql"), "utf8"),
).replace(/\r\n/g, "\n");
/**
 * A versão VIGENTE da função. A 0221 reescreveu a deduplicação (sem ler a timeline do
 * CRM) e manteve a regra do domingo; quem reescrever a função de novo troca este
 * caminho — e este teste confere que a regra veio junto.
 */
const vigente = semComentarios(
  readFileSync(join(raiz, "supabase/migrations/20261110220000_0221_confirmacao_sem_atividades_e_reserva.sql"), "utf8"),
).replace(/\r\n/g, "\n");
const baseline = semComentarios(readFileSync(join(raiz, "supabase/baseline.sql"), "utf8")).replace(/\r\n/g, "\n");

function ultimaDefinicao(sql: string): string {
  const inicio = sql.lastIndexOf("create or replace function public.fn_due_appointment_reminders(");
  const fim = sql.indexOf("revoke all on function public.fn_due_appointment_reminders", inicio);
  return sql.slice(inicio, fim);
}

const corpo = (s: string) => s.slice(s.indexOf("as $$"), s.indexOf("$$;") + 3);
const REGRA_DOMINGO = /extract\(dow from \(\(k\.starts_at at time zone f\.tz\)::date - m\.timing_value\)\) = 0/;

describe("fn_due_appointment_reminders (0213) — nada de aviso no domingo", () => {
  it("⭐ a migration move o aviso de domingo para sábado só em days_before", () => {
    const daysBefore = migration.slice(migration.indexOf("when 'days_before'"), migration.indexOf("else", migration.indexOf("when 'days_before'")));
    expect(daysBefore).toMatch(REGRA_DOMINGO);
    // hours_before e day_of_8am ficam como estavam
    const horas = migration.slice(migration.indexOf("when 'hours_before'"), migration.indexOf("when 'days_before'"));
    expect(horas).not.toMatch(/dow/);
  });

  it("⭐ a definição que vale no baseline mantém a regra, com o mesmo corpo da migration vigente (0221)", () => {
    const def = ultimaDefinicao(baseline);
    expect(def).toMatch(REGRA_DOMINGO);
    expect(corpo(ultimaDefinicao(vigente))).toMatch(REGRA_DOMINGO);
    expect(corpo(def)).toBe(corpo(ultimaDefinicao(vigente)));
  });

  it("mantém a 0212: chaves calculadas uma vez, sem varredura por envio", () => {
    expect(migration).toMatch(/chaves_enviadas as \(/);
    expect(migration).not.toMatch(/occurrence_key\s+in\s*\(\s*select\s+act\.id::text/i);
  });

  it("continua fechada para anon/authenticated e aberta só ao service_role", () => {
    expect(migration).toMatch(/revoke all on function public\.fn_due_appointment_reminders\(uuid, uuid, timestamptz\) from public;/);
    expect(migration).toMatch(/from anon, authenticated;/);
    expect(migration).toMatch(/to service_role;/);
  });
});
