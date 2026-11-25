import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Índices das consultas que rodam sozinhas, o tempo todo (migration 0225).
 *
 * Em 2026-11-25 o CRM parou de abrir porque três delas liam `event_log` e
 * `messages` inteiras a cada execução e esgotaram o Disk IO do banco. O sintoma
 * aparece longe da causa (login carregando sem fim), então o índice sumir de um
 * baseline regenerado não quebraria nada visível — só a produção, dias depois.
 * Este teste é o alarme: confere no banco instalado pelo baseline que cada índice
 * existe, é válido e cobre exatamente o filtro da consulta que ele atende.
 */

const ESPERADOS: Array<{ nome: string; tabela: string; contem: string[] }> = [
  {
    // reaper do drain — lib/agent-engine/edge/crm/drain.ts
    nome: "idx_event_log_reaper_processing",
    tabela: "event_log",
    contem: ["(event_type, updated_at)", "status = 'processing'"],
  },
  {
    // redriveQueued — lib/agent-engine/edge/crm/session-reconciler.ts
    nome: "idx_messages_ai_queued",
    tabela: "messages",
    contem: ["(created_at)", "sent_via = 'ai'", "status = 'queued'"],
  },
  {
    // fn_ia_organizacoes_silenciosas — cron ai-silence-watcher
    nome: "idx_messages_inbound_created",
    tabela: "messages",
    contem: ["(created_at)", "direction = 'inbound'"],
  },
];

describe("índices das consultas de fundo (0225)", () => {
  for (const e of ESPERADOS) {
    it(`${e.nome} existe em ${e.tabela}, válido, com o filtro certo`, () => {
      const linha = sql(
        `select i.indisvalid::text || '|' || pg_get_indexdef(i.indexrelid)
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
           join pg_class t on t.oid = i.indrelid
          where c.relname = '${e.nome}' and t.relname = '${e.tabela}';`,
      );
      expect(linha, `${e.nome} ausente do baseline`).not.toBe("");
      const [valido, def] = linha.split("|");
      expect(valido).toBe("true");
      for (const trecho of e.contem) expect(def).toContain(trecho);
    });
  }
});
