import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { resolveAudience } from "@/lib/campaigns/audience";

import { MAX_ROWS_DO_POSTGREST, pgComoSupabase } from "../pg-como-supabase";

/**
 * O PÚBLICO da campanha — resolvido contra o schema real, não mockado.
 *
 * Congela: (1) tag casa só quem tem a tag; (2) etapa do funil casa só quem
 * está `open` NAQUELA etapa agora, não quem já fechou; (3) `is_blocked`
 * exclui em QUALQUER filtro, sem exceção; (4) sem telefone não entra; (5)
 * dois tenants não vazam público um pro outro — a função filtra
 * `organization_id` na mão (é admin client, sem RLS), e é essa filtragem que
 * se prova aqui.
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
const admin = pgComoSupabase(pool);

const ORG_A = "ca11ec00-0000-4000-8000-000000000001";
const ORG_B = "ca11ec00-0000-4000-8000-000000000002";

let pipelineA = "";
let stageAlvoA = "";
let stageOutraA = "";

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Público LTDA', 'Público') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarContato(
  org: string,
  nome: string,
  telefone: string | null,
  opts: { blocked?: boolean; tags?: string[] } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source, is_blocked, tags)
     values ($1, $2, $3, 'whatsapp', $4, $5) returning id`,
    [org, nome, telefone, opts.blocked ?? false, opts.tags ?? []],
  );
  return rows[0]!.id;
}

async function criarLead(
  org: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
  status: "open" | "won" = "open",
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, status, closed_at, value_cents)
     values ($1, $2, $3, $4, 'lead de teste', $5, $6, $7) returning id`,
    [
      org,
      contactId,
      pipelineId,
      stageId,
      status,
      status === "won" ? new Date() : null,
      status === "won" ? 10000 : null,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await criarOrg(ORG_A, "org-publico-a");
  await criarOrg(ORG_B, "org-publico-b");

  const { rows: pipe } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position)
     values ($1, 'Funil de teste', 'funil-de-teste', false, 100) returning id`,
    [ORG_A],
  );
  pipelineA = pipe[0]!.id;

  const { rows: stages } = await pool.query<{ id: string; slug: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
       ($1, $2, 'Alvo',  'alvo-teste',  0, false, false),
       ($1, $2, 'Outra', 'outra-teste', 1, false, false),
       ($1, $2, 'Ganho', 'ganho-teste', 2, true,  false)
     returning id, slug`,
    [ORG_A, pipelineA],
  );
  stageAlvoA = stages.find((s) => s.slug === "alvo-teste")!.id;
  stageOutraA = stages.find((s) => s.slug === "outra-teste")!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("público por TAG", () => {
  it("⭐ casa só quem tem a tag, exclui bloqueado e exclui quem não tem telefone", async () => {
    const comTag = await criarContato(ORG_A, "Com a tag", "+5511900000001", { tags: ["promo"] });
    await criarContato(ORG_A, "Sem a tag", "+5511900000002", { tags: ["outra"] });
    await criarContato(ORG_A, "Bloqueado com a tag", "+5511900000003", {
      tags: ["promo"],
      blocked: true,
    });
    await criarContato(ORG_A, "Sem telefone com a tag", null, { tags: ["promo"] });

    const publico = await resolveAudience(admin, ORG_A, { kind: "tag", tag: "promo" });
    expect(publico.map((p) => p.contactId)).toEqual([comTag]);
    expect(publico[0]!.leadId).toBeNull();
  });

  it("tag que ninguém tem devolve público vazio, sem erro", async () => {
    const publico = await resolveAudience(admin, ORG_A, { kind: "tag", tag: "tag-que-ninguem-tem" });
    expect(publico).toEqual([]);
  });

  it("⭐ base importada MAIOR que o teto do PostgREST sai inteira, não só as 1.000 primeiras", async () => {
    // 1.205 = uma página cheia + uma parcial. Sem paginar, o público parava em
    // 1.000 em silêncio (o adaptador corta como o PostgREST real). DDD 31: os
    // contatos avulsos deste arquivo são +55119…, e a faixa gerada cobria eles.
    const total = MAX_ROWS_DO_POSTGREST + 205;
    await pool.query(
      `insert into contacts (organization_id, display_name, phone_number, source, tags)
       select $1, 'Importado ' || g, '+55319' || lpad(g::text, 8, '0'), 'import', array['base-grande']
         from generate_series(1, $2::int) g`,
      [ORG_A, total],
    );
    const publico = await resolveAudience(admin, ORG_A, { kind: "tag", tag: "base-grande" });
    expect(publico).toHaveLength(total);
    expect(new Set(publico.map((p) => p.contactId)).size).toBe(total);
  });

  it("contato FUNDIDO em outro não entra — o sobrevivente já está no público", async () => {
    const sobrevivente = await criarContato(ORG_A, "Sobrevivente", "+5511900000091", { tags: ["fusao"] });
    const fundido = await criarContato(ORG_A, "Fundido", "+5511900000092", { tags: ["fusao"] });
    await pool.query("update contacts set is_merged_into = $1, merged_at = now() where id = $2", [
      sobrevivente,
      fundido,
    ]);
    const publico = await resolveAudience(admin, ORG_A, { kind: "tag", tag: "fusao" });
    expect(publico.map((p) => p.contactId)).toEqual([sobrevivente]);
  });
});

describe("público por ETAPA DO FUNIL", () => {
  it("⭐ casa só lead OPEN na etapa alvo — outra etapa e lead fechado ficam de fora", async () => {
    const naEtapaAlvo = await criarContato(ORG_A, "Na etapa alvo", "+5511900000010");
    await criarLead(ORG_A, naEtapaAlvo, pipelineA, stageAlvoA, "open");

    const naOutraEtapa = await criarContato(ORG_A, "Em outra etapa", "+5511900000011");
    await criarLead(ORG_A, naOutraEtapa, pipelineA, stageOutraA, "open");

    const fechouNaAlvo = await criarContato(ORG_A, "Fechou na etapa alvo", "+5511900000012");
    await criarLead(ORG_A, fechouNaAlvo, pipelineA, stageAlvoA, "won");

    const publico = await resolveAudience(admin, ORG_A, {
      kind: "pipeline_stage",
      pipelineId: pipelineA,
      stageId: stageAlvoA,
    });
    expect(publico.map((p) => p.contactId)).toEqual([naEtapaAlvo]);
    expect(publico[0]!.leadId).not.toBeNull();
  });

  /**
   * Achado ao vivo (RevitaFio Mossoró, 2026-09-16): "Nenhum contato bate com
   * esse público" pra uma etapa que tinha 31 contatos válidos — porque a
   * MESMA etapa também tinha leads criados direto no Kanban, sem contato
   * vinculado (`contact_id null`, o mesmo padrão já visto nesta sessão pra
   * este tenant). O `null` entrava no array do `.in("id", contactIds)`, o
   * PostgREST recusava a query INTEIRA (`22P02 invalid uuid`), e como o erro
   * nunca era checado isso derrubava o público pra ZERO — não só o lead
   * órfão, TODOS os outros da etapa junto.
   */
  it("⭐ lead órfão (sem contato vinculado) na mesma etapa não derruba o público inteiro", async () => {
    const comContato = await criarContato(ORG_A, "Com contato de verdade", "+5511900000015");
    await criarLead(ORG_A, comContato, pipelineA, stageAlvoA, "open");

    await pool.query(
      `insert into crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, status)
       values ($1, null, $2, $3, 'lead órfão de teste', 'open')`,
      [ORG_A, pipelineA, stageAlvoA],
    );

    const publico = await resolveAudience(admin, ORG_A, {
      kind: "pipeline_stage",
      pipelineId: pipelineA,
      stageId: stageAlvoA,
    });
    expect(publico.map((p) => p.contactId)).toContain(comContato);
  });

  it("contato bloqueado na etapa certa não entra", async () => {
    const bloqueado = await criarContato(ORG_A, "Bloqueado na etapa", "+5511900000020", {
      blocked: true,
    });
    await criarLead(ORG_A, bloqueado, pipelineA, stageAlvoA, "open");

    const publico = await resolveAudience(admin, ORG_A, {
      kind: "pipeline_stage",
      pipelineId: pipelineA,
      stageId: stageAlvoA,
    });
    expect(publico.map((p) => p.contactId)).not.toContain(bloqueado);
  });
});

describe("público por TODOS OS CONTATOS", () => {
  it("inclui todo mundo com telefone e não bloqueado — exclui os outros dois", async () => {
    await criarOrg("ca11ec00-0000-4000-8000-000000000003", "org-publico-todos");
    const ORG_TODOS = "ca11ec00-0000-4000-8000-000000000003";
    const ok = await criarContato(ORG_TODOS, "Ok", "+5511900000030");
    await criarContato(ORG_TODOS, "Bloqueado", "+5511900000031", { blocked: true });
    await criarContato(ORG_TODOS, "Sem telefone", null);

    const publico = await resolveAudience(admin, ORG_TODOS, { kind: "all_contacts" });
    expect(publico.map((p) => p.contactId)).toEqual([ok]);

    await pool.query("delete from organizations where id = $1", [ORG_TODOS]);
  });
});

describe("isolamento entre organizações", () => {
  it("⭐ o mesmo filtro na ORG_B não vê nada da ORG_A", async () => {
    await criarContato(ORG_A, "Só da A", "+5511900000040", { tags: ["isolamento"] });

    const publicoB = await resolveAudience(admin, ORG_B, { kind: "tag", tag: "isolamento" });
    expect(publicoB).toEqual([]);
  });
});
