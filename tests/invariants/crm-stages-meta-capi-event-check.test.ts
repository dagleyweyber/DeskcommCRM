import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `crm_stages.meta_capi_event_name` (migration 0180) — vocabulário FECHADO de
 * propósito (ao contrário de `crm_lead_activities.type`): são nomes de evento
 * padrão do Meta, e um valor fora da lista vira um evento que a Meta rejeita
 * do outro lado, sem nenhum aviso aqui. Este invariante prova as duas pontas
 * que importam pra quem atualiza um banco de clone existente: a constraint
 * recusa lixo, e a coluna nasce `null` (nenhuma etapa dispara nada por
 * acidente).
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

const ORG = "6e7ac10d-0000-4000-8000-000000000020";
const PIPELINE = "6e7ac10d-0000-4000-8000-000000000021";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-meta-capi-event-invariant', 'Meta CAPI LTDA', 'Meta CAPI')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default, position)
     values ($1, $2, 'Funil de teste', 'funil-meta-capi-teste', false, 100)
     on conflict (id) do nothing`,
    [PIPELINE, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("crm_stages.meta_capi_event_name — vocabulário fechado", () => {
  it("⭐ nasce null numa etapa nova — nenhuma etapa dispara sinal sem escolha explícita", async () => {
    const { rows } = await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
       values ($1, $2, 'Etapa sem sinal', 'etapa-sem-sinal', 1000)
       returning meta_capi_event_name`,
      [ORG, PIPELINE],
    );
    expect(rows[0].meta_capi_event_name).toBeNull();
  });

  it("⭐ aceita um valor da lista (Schedule)", async () => {
    const { rows } = await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, meta_capi_event_name)
       values ($1, $2, 'Avaliação Agendada (teste)', 'avaliacao-agendada-teste', 2000, 'Schedule')
       returning meta_capi_event_name`,
      [ORG, PIPELINE],
    );
    expect(rows[0].meta_capi_event_name).toBe("Schedule");
  });

  it("⭐ recusa valor fora da lista — 23514, não deixa passar um typo pra virar evento rejeitado pela Meta", async () => {
    await expect(
      pool.query(
        `insert into crm_stages (organization_id, pipeline_id, name, slug, position, meta_capi_event_name)
         values ($1, $2, 'Etapa com typo', 'etapa-com-typo', 3000, 'Shedule')`,
        [ORG, PIPELINE],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
