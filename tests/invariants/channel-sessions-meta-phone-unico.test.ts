import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Um número da Meta, uma sessão ATIVA (migration 0194).
 *
 * O que só o banco responde: o índice único parcial existe no baseline fresco e
 * recusa a SEGUNDA sessão ativa com o mesmo `meta_phone_number_id` — na mesma
 * organização ou em outra — mas deixa sessão arquivada repetir o id (é o caso de
 * reconectar um número já usado, o cenário que motivou a migration).
 *
 * Namespace PRÓPRIO (`3e7a` + fixtures com sufixo): o banco efêmero é
 * compartilhado entre arquivos que rodam em paralelo.
 */
const ORG_A = "3e7a0000-0000-4000-8000-00000000000a";
const ORG_B = "3e7a0000-0000-4000-8000-00000000000b";
const NUMERO = "3e7a-numero-meta-0001";

function criaSessao(id: string, org: string, opts: { arquivada?: boolean } = {}): string | null {
  try {
    sql(`
      insert into public.channel_sessions
        (id, organization_id, provider, meta_phone_number_id, webhook_secret_encrypted, archived_at)
      values ('${id}', '${org}', 'meta_cloud', '${NUMERO}', '\\x00'::bytea,
              ${opts.arquivada ? "now()" : "null"});
    `);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

describe("channel_sessions — número da Meta único entre sessões ativas (migration 0194)", () => {
  beforeAll(() => {
    sql(`
      delete from public.channel_sessions where meta_phone_number_id = '${NUMERO}';
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_A}', 'org-meta-phone-a', 'Org A', 'Org A'),
        ('${ORG_B}', 'org-meta-phone-b', 'Org B', 'Org B')
        on conflict do nothing;
    `);
  });

  it("a primeira sessão ativa com o número entra", () => {
    expect(criaSessao("3e7a0000-0000-4000-8000-0000000000a1", ORG_A)).toBeNull();
  });

  it("⭐ a SEGUNDA sessão ativa com o mesmo número é recusada — mesma organização", () => {
    const erro = criaSessao("3e7a0000-0000-4000-8000-0000000000a2", ORG_A);
    expect(erro, "duas sessões ativas pro mesmo número têm que violar o índice").toMatch(
      /channel_sessions_meta_phone_active_uidx|duplicate key/,
    );
  });

  it("⭐ ...e também recusada em OUTRA organização (um número não atende dois clientes)", () => {
    const erro = criaSessao("3e7a0000-0000-4000-8000-0000000000b1", ORG_B);
    expect(erro).toMatch(/channel_sessions_meta_phone_active_uidx|duplicate key/);
  });

  it("⭐ sessão ARQUIVADA pode repetir o número — é o histórico de quem reconecta", () => {
    expect(criaSessao("3e7a0000-0000-4000-8000-0000000000a3", ORG_A, { arquivada: true })).toBeNull();
  });

  it("arquivar a ativa libera o número pra uma nova (a ordem que o app segue)", () => {
    sql(`update public.channel_sessions set archived_at = now()
         where id = '3e7a0000-0000-4000-8000-0000000000a1';`);
    expect(criaSessao("3e7a0000-0000-4000-8000-0000000000a4", ORG_A)).toBeNull();
  });
});
