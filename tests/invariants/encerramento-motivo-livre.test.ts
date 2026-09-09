import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { encerraDemanda } from "@/lib/leads/encerramento";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * Achado ao vivo (B'Laser Caruaru): marcar como perdido escolhendo "Outros" e
 * digitando uma descrição nunca confirmava. `lost_reason` só aceita um código
 * canônico ou uma extensão CURADA por pipeline — a trigger
 * `fn_validate_lost_reason_required` recusa qualquer outro texto, e nem o
 * diálogo humano nem a ferramenta MCP da IA (`crm_close_demand`) checavam a
 * lista antes de mandar. `encerraDemanda` agora cai pra `other` só quando a
 * trigger já recusou, preservando o texto original como detalhe da timeline —
 * provado aqui contra a trigger REAL, não uma cópia da regra em TS.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "e1c1e1c1-0000-4000-8000-000000000001";
const PIPELINE = "e1c1e1c1-5555-4000-8000-000000000001";
const STAGE_ABERTO = "e1c1e1c1-5555-4000-8000-000000000002";
const STAGE_PERDIDO = "e1c1e1c1-5555-4000-8000-000000000003";
const PIPELINE_COM_EXTRA = "e1c1e1c1-5555-4000-8000-000000000004";
const STAGE_PERDIDO_EXTRA = "e1c1e1c1-5555-4000-8000-000000000005";

async function novoLead(id: string, pipelineId: string, stageId: string, contactId: string): Promise<void> {
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status)
     values ($1, $2, $3, $4, $5, 'Negócio de teste', 'open')`,
    [id, ORG, pipelineId, stageId, contactId],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'encerramento-motivo-livre', 'Org Teste', 'Org Teste') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1, $2, 'Funil Padrão', 'funil-padrao'),
       ($3, $2, 'Funil Com Extra', 'funil-com-extra')
     on conflict (id) do nothing`,
    [PIPELINE, ORG, PIPELINE_COM_EXTRA],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost) values
       ($1, $2, $3, 'Aberto', 'aberto', 1000, false),
       ($4, $2, $3, 'Perdido', 'perdido', 2000, true),
       ($5, $2, $6, 'Perdido', 'perdido', 1000, true)
     on conflict (id) do nothing`,
    [STAGE_ABERTO, ORG, PIPELINE, STAGE_PERDIDO, STAGE_PERDIDO_EXTRA, PIPELINE_COM_EXTRA],
  );
  // Pipeline com uma extensão CURADA — este texto exato deve ser aceito como está.
  await pool.query(
    `update crm_pipelines set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{lost_reasons}', '["Concorrente ganhou"]'::jsonb)
     where id = $1`,
    [PIPELINE_COM_EXTRA],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name, phone_number)
     values ($1, $2, 'Contato Teste', '+5599900000001') on conflict (id) do nothing`,
    ["e1c1e1c1-6666-4000-8000-000000000001", ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

const CONTACT = "e1c1e1c1-6666-4000-8000-000000000001";
const ctx = { organization_id: ORG, actor: { type: "user" as const, id: "e1c1e1c1-9999-4000-8000-000000000001" }, requestId: "req-teste" };

describe("encerraDemanda — motivo livre em 'Outros' não trava mais o encerramento", () => {
  it("⭐ texto livre digitado no 'Outros' é aceito: grava lost_reason='other' e preserva o texto na timeline", async () => {
    const leadId = "e1c1e1c1-7777-4000-8000-000000000001";
    await novoLead(leadId, PIPELINE, STAGE_ABERTO, CONTACT);

    const { lead } = await encerraDemanda(db, ctx, {
      leadId,
      desfecho: "lost",
      motivo: "Cliente disse que vai fechar com a prima que também vende",
    });

    expect((lead as { lost_reason: string }).lost_reason).toBe("other");
    expect((lead as { status: string }).status).toBe("lost");

    const { rows } = await pool.query<{ reason: string }>(
      "select reason from crm_lead_activities where lead_id = $1 and type = 'demand_closed'",
      [leadId],
    );
    expect(rows[0]?.reason).toContain("Cliente disse que vai fechar com a prima que também vende");
    expect(rows[0]?.reason).toContain("Outro motivo");
  });

  it("código canônico continua indo direto, sem precisar do fallback", async () => {
    const leadId = "e1c1e1c1-7777-4000-8000-000000000002";
    await novoLead(leadId, PIPELINE, STAGE_ABERTO, CONTACT);

    const { lead } = await encerraDemanda(db, ctx, { leadId, desfecho: "lost", motivo: "price" });

    expect((lead as { lost_reason: string }).lost_reason).toBe("price");
    const { rows } = await pool.query<{ reason: string }>(
      "select reason from crm_lead_activities where lead_id = $1 and type = 'demand_closed'",
      [leadId],
    );
    expect(rows[0]?.reason).toBe("Perdido — Preço");
  });

  it("extensão curada do pipeline (settings.lost_reasons) é aceita como está, sem cair pra 'other'", async () => {
    const leadId = "e1c1e1c1-7777-4000-8000-000000000003";
    await novoLead(leadId, PIPELINE_COM_EXTRA, STAGE_PERDIDO_EXTRA, CONTACT);
    // O stage de perda deste pipeline já É o 'perdido' — muda de stage_id mesmo
    // assim (o mesmo), só provando que o motivo passa direto.

    const { lead } = await encerraDemanda(db, ctx, {
      leadId,
      desfecho: "lost",
      motivo: "Concorrente ganhou",
    });

    expect((lead as { lost_reason: string }).lost_reason).toBe("Concorrente ganhou");
  });
});
