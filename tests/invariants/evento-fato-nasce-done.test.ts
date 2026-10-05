import { describe, it, expect, beforeAll } from "vitest";

import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Migration 0183 — eventos "fato" (`message.sent`, `whatsapp.chat_id_not_recognized`)
 * nascem `done`, não `pending`.
 *
 * Causa raiz (lentidão relatada pela RevitaFio Mossoró): esses 2 tipos são
 * "fato" sem consumidor por doutrina (issue #129) — `emit_event()` sempre
 * inseria com o default `pending`, e `drainEventLog()` só reclama tipos com
 * handler registrado, então essas linhas nunca saíam de `pending`. 48 dias de
 * acúmulo (25.155 linhas) inflaram o índice parcial que o drain escaneia
 * globalmente até bater em `statement timeout` nele mesmo.
 *
 * Este invariante prova as duas pontas: os 2 tipos "fato" nascem `done`
 * direto (não passam mais por `pending`), e um tipo "comando" normal
 * (`ai_agent.dispatch_requested`) continua nascendo `pending` — não é uma
 * regra geral, é só pra esses 2 tipos nomeados.
 */

function emit(eventType: string): string {
  const out = sql(
    `select public.emit_event('${eventType}', 'test', null, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}');`,
  );
  return lastLine(out);
}

function statusOf(id: string): string {
  return sql(`select status from public.event_log where id = '${id}';`);
}

describe("emit_event — eventos 'fato' sem consumidor nascem done (migration 0183)", () => {
  beforeAll(() => {
    seedGov();
  });

  it("message.sent nasce done, não pending", () => {
    const id = emit("message.sent");
    expect(statusOf(id)).toBe("done");
  });

  it("whatsapp.chat_id_not_recognized nasce done, não pending", () => {
    const id = emit("whatsapp.chat_id_not_recognized");
    expect(statusOf(id)).toBe("done");
  });

  it("guarda de regressão: um tipo 'comando' normal continua nascendo pending", () => {
    const id = emit("ai_agent.dispatch_requested");
    expect(statusOf(id)).toBe("pending");
  });

  it("backlog antigo: UPDATE de limpeza da 0183 é idempotente (reaplicar não falha nem muda linha já done)", () => {
    const id = emit("message.sent");
    expect(statusOf(id)).toBe("done");
    sql(
      `update public.event_log
         set status = 'done', updated_at = now()
         where status = 'pending'
           and event_type in ('message.sent', 'whatsapp.chat_id_not_recognized');`,
    );
    expect(statusOf(id)).toBe("done");
  });
});
