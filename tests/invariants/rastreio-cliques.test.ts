import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0203 — `rastreio_cliques`: a ponte entre o clique no botão do WhatsApp da
 * landing page e a conversa que chega depois.
 *
 * O isolamento entre organizações é provado em `rls-isolation.test.ts`. Aqui: o que o anon
 * pode fazer, que só o servidor escreve, e as restrições que a rota pública e a ligação
 * da conversa assumem (formato do código, unicidade por organização).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda o SQL e devolve a mensagem de erro (ou "" se passou). */
function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
}

const ORG_1 = "a0203000-0000-4000-8000-000000000001";
const ORG_2 = "a0203000-0000-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_1}', 'org-cliques-1', 'Cliques Um LTDA', 'Cliques Um'),
      ('${ORG_2}', 'org-cliques-2', 'Cliques Dois LTDA', 'Cliques Dois')
      on conflict (id) do nothing;
    delete from public.rastreio_cliques where organization_id in ('${ORG_1}', '${ORG_2}');
  `);
});

describe("rastreio_cliques — permissões", () => {
  it("⭐ RLS ligada e anon sem nenhum privilégio (tabela nova nasce concedida a anon)", () => {
    const out = sql(`
      select c.relrowsecurity,
             has_table_privilege('anon', 'public.rastreio_cliques', 'select'),
             has_table_privilege('anon', 'public.rastreio_cliques', 'insert')
        from pg_class c where c.oid = 'public.rastreio_cliques'::regclass;
    `);
    expect(out).toBe("t|f|f");
  });

  it("⭐ usuário autenticado só LÊ (sem policy de escrita) — quem grava é o servidor, depois de validar o token", () => {
    const out = sql(`
      select string_agg(cmd, ',' order by cmd) from pg_policies
       where schemaname = 'public' and tablename = 'rastreio_cliques';
    `);
    expect(out).toBe("SELECT");
  });
});

describe("rastreio_cliques — restrições", () => {
  it("⭐ o formato do código é garantido pelo banco: sem 0/O/1/I, 6 símbolos, só maiúscula", () => {
    for (const ruim of ["K7M2Q0", "K7M2QO", "K7M2Q1", "K7M2QI", "K7M2Q", "K7M2QXA", "k7m2qx"]) {
      const erro = erroDe(`insert into public.rastreio_cliques (organization_id, codigo) values ('${ORG_1}', '${ruim}');`);
      expect(erro, `código ${ruim} deveria ser recusado`).toMatch(/check constraint/);
    }
    expect(erroDe(`insert into public.rastreio_cliques (organization_id, codigo) values ('${ORG_1}', 'K7M2QX');`)).toBe("");
  });

  it("⭐ o código é único por ORGANIZAÇÃO: repetir na mesma recusa; na outra, vale", () => {
    expect(erroDe(`insert into public.rastreio_cliques (organization_id, codigo) values ('${ORG_1}', 'K7M2QX');`)).toMatch(
      /duplicate key|unique/,
    );
    expect(erroDe(`insert into public.rastreio_cliques (organization_id, codigo) values ('${ORG_2}', 'K7M2QX');`)).toBe("");
  });

  it("parâmetros começam vazios e o clique nasce não usado", () => {
    const out = sql(`select parametros::text, usado_em is null, lead_id is null from public.rastreio_cliques where organization_id = '${ORG_1}' and codigo = 'K7M2QX';`);
    expect(out).toBe("{}|t|t");
  });

  it("apagar a organização leva os cliques junto (sem dado órfão)", () => {
    sql(`delete from public.organizations where id = '${ORG_2}';`);
    expect(sql(`select count(*) from public.rastreio_cliques where organization_id = '${ORG_2}';`)).toBe("0");
  });
});
