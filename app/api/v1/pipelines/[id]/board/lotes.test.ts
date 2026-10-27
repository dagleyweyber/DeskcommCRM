import { beforeEach, describe, expect, it, vi } from "vitest";

import { IDS_POR_LOTE } from "@/lib/supabase/in-em-lotes";

/**
 * Achado ao vivo (B'laser Caruaru, 2026-10-27): o quadro mandava a lista inteira de ids
 * dos leads numa única consulta `.in()`. Com ~400 leads a URL passa de ~15 KB e o
 * servidor falha com "TypeError: fetch failed" — o Kanban da clínica não abria.
 */
const PIPELINE = "e86702dc-a7a8-4125-9352-838113392046";
const ORG = "fd8c0543-31e9-422f-b2df-74285d32520b";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

interface ChamadaIn {
  tabela: string;
  coluna: string;
  valores: string[];
}

const chamadasIn: ChamadaIn[] = [];
let totalDeLeads = 0;

function leadsDoFunil() {
  return Array.from({ length: totalDeLeads }, (_, i) => ({
    id: uuid(i),
    organization_id: ORG,
    pipeline_id: PIPELINE,
    stage_id: uuid(900000),
    contact_id: uuid(500000 + i),
    status: "open",
    owner_kind: "human",
    owner_agent_id: null,
  }));
}

/** Um construtor de consulta de mentira: registra cada `.in()` e responde por tabela. */
function consulta(tabela: string) {
  let selecao = "";
  const b: Record<string, unknown> = {};
  const encadeia = () => b;
  b.select = (colunas: string) => {
    selecao = colunas;
    return b;
  };
  b.in = (coluna: string, valores: string[]) => {
    chamadasIn.push({ tabela, coluna, valores });
    return b;
  };
  for (const metodo of ["eq", "neq", "not", "order"]) b[metodo] = encadeia;
  b.maybeSingle = async () => ({
    data: tabela === "crm_pipelines" ? { id: PIPELINE, organization_id: ORG } : null,
    error: null,
  });
  b.then = (resolve: (r: unknown) => unknown) => {
    const linhas = tabela === "crm_leads" && selecao === "*" ? leadsDoFunil() : [];
    return Promise.resolve({ data: linhas, error: null }).then(resolve);
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: (tabela: string) => consulta(tabela),
  }),
}));

describe("GET /api/v1/pipelines/[id]/board — listas de ids em lotes", () => {
  beforeEach(() => {
    chamadasIn.length = 0;
  });

  it("⭐ funil de 500 leads (acima do ponto de quebra): nenhuma consulta leva mais que um lote de ids", async () => {
    totalDeLeads = 500;
    const { GET } = await import("./route");

    const res = await GET(new Request("http://t/x") as never, { params: Promise.resolve({ id: PIPELINE }) });
    expect(res.status).toBe(200);

    const grandes = chamadasIn.filter((c) => c.valores.length > IDS_POR_LOTE);
    expect(grandes).toEqual([]);

    // As colunas que crescem com o funil foram consultadas, e TODOS os ids passaram por elas.
    for (const [tabela, coluna] of [
      ["crm_lead_scores", "lead_id"],
      ["crm_lead_activities", "lead_id"],
      ["conversations", "contact_id"],
      ["lead_state", "contact_id"],
    ] as const) {
      const doGrupo = chamadasIn.filter((c) => c.tabela === tabela && c.coluna === coluna);
      expect(doGrupo.length, `${tabela}.${coluna}`).toBeGreaterThan(1);
      expect(new Set(doGrupo.flatMap((c) => c.valores)).size, `${tabela}.${coluna}`).toBe(500);
    }
  });

  it("⭐ a URL de cada lote fica muito abaixo do limite medido (~15 KB)", async () => {
    totalDeLeads = 800;
    const { GET } = await import("./route");
    await GET(new Request("http://t/x") as never, { params: Promise.resolve({ id: PIPELINE }) });

    for (const c of chamadasIn) {
      const url = `${c.tabela}?organization_id=eq.${ORG}&${c.coluna}=in.(${c.valores.join(",")})`;
      expect(url.length, `${c.tabela}.${c.coluna}`).toBeLessThan(8_000);
    }
  });
});
