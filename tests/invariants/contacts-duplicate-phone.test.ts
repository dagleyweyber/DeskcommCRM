import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * Achado ao vivo (RevitaFio Mossoró): criar um lead com telefone já
 * cadastrado mostrava o erro CRU do Postgres pro usuário —
 * `duplicate key value violates unique constraint "uniq_contacts_org_phone"`
 * — porque `createContactHandler` jogava QUALQUER falha de INSERT como
 * `internal_error`, e esse código é desenhado (`ApiErrorToast.tsx`) pra
 * deixar a mensagem do servidor passar direto pro toast. `23505` num
 * telefone duplicado não é "erro interno" — é caso esperado, e precisa de
 * mensagem amigável (`contact_duplicate_phone`/`contact_duplicate_email`),
 * não do balde genérico.
 *
 * Invariante de banco (não unit com mock) porque a constraint que gera o
 * `23505` só existe no Postgres real — mockar o erro provaria só que o
 * código lê um objeto fabricado, não que a constraint de verdade dispara.
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

const ORG = "6e7ac10d-0000-4000-8000-000000000002";
const ACTOR_USER_ID = "6e7ac10d-0000-4000-8000-0000000000aa";

const ctx = { organization_id: ORG, actor: { type: "user" as const, id: ACTOR_USER_ID }, requestId: "req-teste" };

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-contacts-duplicate-invariant', 'Duplicado LTDA', 'Duplicado')
     on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("createContactHandler — telefone/e-mail duplicado vira mensagem amigável", () => {
  it("⭐ segundo contato com o MESMO telefone na mesma org: 409 contact_duplicate_phone, não 500 internal_error", async () => {
    await createContactHandler(db, ctx, {
      phone_number: "+5511988887777",
      source: "manual",
    });

    await expect(
      createContactHandler(db, ctx, {
        phone_number: "+5511988887777",
        source: "manual",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "contact_duplicate_phone",
      message: "Já existe um contato com este telefone nesta organização.",
    });
  });

  it("mesmo telefone em ORGANIZAÇÃO DIFERENTE não colide — a constraint é por org", async () => {
    const outraOrg = "6e7ac10d-0000-4000-8000-000000000003";
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, 'org-contacts-duplicate-invariant-2', 'Outra LTDA', 'Outra')
       on conflict (id) do nothing`,
      [outraOrg],
    );
    try {
      const r = await createContactHandler(
        db,
        { ...ctx, organization_id: outraOrg },
        { phone_number: "+5511988887777", source: "manual" },
      );
      expect(r.contact.phone_number).toBe("+5511988887777");
    } finally {
      await pool.query("delete from organizations where id = $1", [outraOrg]);
    }
  });

  it("⭐ segundo contato com o MESMO e-mail na mesma org: 409 contact_duplicate_email", async () => {
    await createContactHandler(db, ctx, {
      email: "duplicado@exemplo.com",
      source: "manual",
    });

    await expect(
      createContactHandler(db, ctx, {
        email: "duplicado@exemplo.com",
        source: "manual",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "contact_duplicate_email",
    });
  });

  it("erro de constraint chega como instância de ApiError (não erro cru do pg)", async () => {
    await createContactHandler(db, ctx, {
      phone_number: "+5511977776666",
      source: "manual",
    });

    let capturado: unknown;
    try {
      await createContactHandler(db, ctx, {
        phone_number: "+5511977776666",
        source: "manual",
      });
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBeInstanceOf(ApiError);
  });
});
