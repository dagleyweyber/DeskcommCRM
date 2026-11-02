import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { phoneLookupVariants } from "@/lib/channels/phone-variants";

/**
 * Migration 0210 — `fn_importar_contatos`, contra o schema real (baseline).
 *
 * O que se congela aqui é o que NÃO pode acontecer numa importação em massa:
 * duplicar quem já existe (9º dígito), trocar tag ou nome de quem já tem,
 * desbloquear quem pediu para sair, virar "sim" um consentimento que era
 * "não", trazer de volta um anonimizado, criar lead no Kanban, ou gravar em
 * outra organização.
 *
 * Namespace `1aa0c7` — exclusivo deste arquivo.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "1aa0c700-0000-4000-8000-000000000001";
const ORG_OUTRA = "1aa0c700-0000-4000-8000-000000000002";
const MEMBRO = "1aa0c700-1111-4000-8000-000000000001";

interface Linha {
  linha: number;
  telefone: string;
  nome?: string | null;
  email?: string | null;
  tags?: string[];
}

type Resultado = { linha: number; resultado: string; motivo: string | null; contact_id: string | null };

/** Chama como o servidor faz: telefone E.164 + variantes calculadas no TypeScript. */
async function importar(
  linhas: Linha[],
  opts: { tags?: string[]; consentir?: boolean; org?: string; comoUsuario?: string } = {},
): Promise<Resultado[]> {
  const payload = linhas.map((l) => ({ ...l, variantes: phoneLookupVariants(l.telefone), tags: l.tags ?? [] }));
  const cli = await pool.connect();
  try {
    await cli.query("begin");
    if (opts.comoUsuario) {
      await cli.query("set local role authenticated");
      await cli.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: opts.comoUsuario, role: "authenticated" }),
      ]);
    }
    const { rows } = await cli.query<Resultado>(
      `select * from public.fn_importar_contatos($1, $2::jsonb, $3, $4, $5::jsonb) order by linha`,
      [opts.org ?? ORG, JSON.stringify(payload), opts.tags ?? [], opts.consentir ?? true, JSON.stringify({ import_id: "t" })],
    );
    await cli.query("commit");
    return rows;
  } catch (e) {
    await cli.query("rollback");
    throw e;
  } finally {
    cli.release();
  }
}

async function contato(id: string) {
  const { rows } = await pool.query(
    `select name, display_name, email, tags, source, is_blocked, consent from contacts where id = $1`,
    [id],
  );
  return rows[0] as {
    name: string | null;
    display_name: string | null;
    email: string | null;
    tags: string[];
    source: string;
    is_blocked: boolean;
    consent: Record<string, { granted_at?: string | null; revoked_at?: string | null; source?: string }>;
  };
}

async function criarContato(campos: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(campos);
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, source, ${cols.join(", ")})
     values ($1, 'whatsapp', ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [ORG, ...Object.values(campos)],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-importa"],
    [ORG_OUTRA, "org-importa-outra"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text) on conflict do nothing`,
      [id, slug],
    );
  }
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'membro-importa@invariant.test') on conflict do nothing`,
    [MEMBRO],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'manager', now()) on conflict do nothing`,
    [MEMBRO, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_OUTRA]]);
  await pool.query("delete from auth.users where id = $1", [MEMBRO]);
  await pool.end();
});

describe("fn_importar_contatos — quem não existe", () => {
  it("⭐ nasce com origem 'import', as tags do lote + da linha e o consentimento de marketing", async () => {
    const [r] = await importar([{ linha: 2, telefone: "+5581988880001", nome: "Ana Nova", tags: ["laser"] }], {
      tags: ["base-2024"],
    });
    expect(r).toMatchObject({ linha: 2, resultado: "criado", motivo: null });
    const c = await contato(r!.contact_id!);
    expect(c.source).toBe("import");
    expect(c.display_name).toBe("Ana Nova");
    expect([...c.tags].sort()).toEqual(["base-2024", "laser"]);
    expect(c.consent.marketing?.granted_at).toBeTruthy();
    expect(c.consent.marketing?.source).toBe("import");
  });

  it("sem a declaração de consentimento, nasce sem consentimento", async () => {
    const [r] = await importar([{ linha: 2, telefone: "+5581988880002" }], { consentir: false });
    expect((await contato(r!.contact_id!)).consent).toEqual({});
  });

  it("⭐ NÃO cria lead no Kanban", async () => {
    const antes = await pool.query(`select count(*)::int n from crm_leads where organization_id = $1`, [ORG]);
    await importar([{ linha: 2, telefone: "+5581988880003", nome: "Sem Lead" }]);
    const depois = await pool.query(`select count(*)::int n from crm_leads where organization_id = $1`, [ORG]);
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });
});

describe("fn_importar_contatos — quem já existe", () => {
  it("⭐ acha a pessoa gravada SEM o 9º dígito (como o WhatsApp grava) — não duplica", async () => {
    const id = await criarContato({ phone_number: "+558177770001", display_name: "Vivi", tags: ["whatsapp"] });
    const [r] = await importar([{ linha: 2, telefone: "+5581977770001", nome: "Vivianne Maria" }], {
      tags: ["base-2024"],
    });
    expect(r).toMatchObject({ resultado: "atualizado", contact_id: id });
    const n = await pool.query(
      `select count(*)::int n from contacts where organization_id = $1 and phone_number = any($2)`,
      [ORG, ["+558177770001", "+5581977770001"]],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("⭐ tags SOMAM e nome existente NÃO é trocado", async () => {
    const id = await criarContato({ phone_number: "+5581977770002", display_name: "Carla", name: "Carla", tags: ["vip"] });
    await importar([{ linha: 2, telefone: "+5581977770002", nome: "CARLA DA SILVA", tags: ["laser"] }], {
      tags: ["base-2024"],
    });
    const c = await contato(id);
    expect([...c.tags].sort()).toEqual(["base-2024", "laser", "vip"]);
    expect(c.display_name).toBe("Carla");
    expect(c.name).toBe("Carla");
  });

  it("nome vazio (ou igual ao telefone) é preenchido", async () => {
    const id = await criarContato({ phone_number: "+5581977770003", name: "+5581977770003" });
    await importar([{ linha: 2, telefone: "+5581977770003", nome: "Bruna" }]);
    const c = await contato(id);
    expect(c.display_name).toBe("Bruna");
    expect(c.name).toBe("Bruna");
  });

  it("⭐ quem pediu para sair continua BLOQUEADO — e a tela é avisada", async () => {
    const id = await criarContato({ phone_number: "+5581977770004", is_blocked: true });
    const [r] = await importar([{ linha: 2, telefone: "+5581977770004" }]);
    expect(r).toMatchObject({ resultado: "atualizado", motivo: "bloqueado" });
    expect((await contato(id)).is_blocked).toBe(true);
  });

  it("⭐ consentimento revogado NUNCA vira concedido por importação", async () => {
    const consent = { marketing: { granted_at: null, revoked_at: "2026-01-01T00:00:00Z", source: "whatsapp" } };
    const id = await criarContato({ phone_number: "+5581977770005", consent: JSON.stringify(consent) });
    await importar([{ linha: 2, telefone: "+5581977770005" }], { consentir: true });
    expect((await contato(id)).consent.marketing).toEqual(consent.marketing);
  });

  it("anonimizado (LGPD) é ignorado e não ganha dado", async () => {
    const id = await criarContato({
      phone_number: "+5581977770006",
      is_anonymized: true,
      anonymized_at: new Date().toISOString(),
      display_name: "Cliente Anonimizado #1",
    });
    const [r] = await importar([{ linha: 2, telefone: "+5581977770006", nome: "Nome Real" }], { tags: ["x"] });
    expect(r).toMatchObject({ resultado: "ignorado", motivo: "anonimizado" });
    const c = await contato(id);
    expect(c.display_name).toBe("Cliente Anonimizado #1");
    expect(c.tags).toEqual([]);
  });

  it("e-mail que já é de OUTRA pessoa não derruba a linha: o contato entra sem ele", async () => {
    await criarContato({ phone_number: "+5581977770007", email: "dona@clinica.com" });
    const [r] = await importar([{ linha: 2, telefone: "+5581977770008", email: "dona@clinica.com" }]);
    expect(r!.resultado).toBe("criado");
    expect((await contato(r!.contact_id!)).email).toBeNull();
  });

  it("a mesma pessoa duas vezes no mesmo lote: a segunda vira atualização, não duplicata", async () => {
    const rs = await importar([
      { linha: 2, telefone: "+5581966660001", tags: ["a"] },
      { linha: 3, telefone: "+558166660001", tags: ["b"] },
    ]);
    expect(rs.map((r) => r.resultado)).toEqual(["criado", "atualizado"]);
    expect(rs[0]!.contact_id).toBe(rs[1]!.contact_id);
    expect([...(await contato(rs[0]!.contact_id!)).tags].sort()).toEqual(["a", "b"]);
  });
});

describe("fn_importar_contatos — isolamento (security invoker, RLS do chamador)", () => {
  it("membro da organização importa normalmente como `authenticated`", async () => {
    const [r] = await importar([{ linha: 2, telefone: "+5581955550001" }], { comoUsuario: MEMBRO });
    expect(r!.resultado).toBe("criado");
  });

  it("⭐ o mesmo usuário NÃO grava em outra organização, mesmo passando o id dela", async () => {
    await expect(
      importar([{ linha: 2, telefone: "+5581955550002" }], { comoUsuario: MEMBRO, org: ORG_OUTRA }),
    ).rejects.toThrow(/row-level security/);
    const n = await pool.query(`select count(*)::int n from contacts where organization_id = $1`, [ORG_OUTRA]);
    expect(n.rows[0].n).toBe(0);
  });

  it("anon não executa a função", async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon', 'public.fn_importar_contatos(uuid, jsonb, text[], boolean, jsonb)', 'execute') as pode`,
    );
    expect(rows[0].pode).toBe(false);
  });
});

describe("fn_tags_dos_contatos", () => {
  it("conta contatos por tag, só da organização pedida", async () => {
    await importar(
      [
        { linha: 2, telefone: "+5581944440001" },
        { linha: 3, telefone: "+5581944440002" },
      ],
      { tags: ["contagem-x"] },
    );
    const { rows } = await pool.query(`select tag, total::int from public.fn_tags_dos_contatos($1) where tag = 'contagem-x'`, [
      ORG,
    ]);
    expect(rows).toEqual([{ tag: "contagem-x", total: 2 }]);
    const outra = await pool.query(`select count(*)::int n from public.fn_tags_dos_contatos($1)`, [ORG_OUTRA]);
    expect(outra.rows[0].n).toBe(0);
  });
});
