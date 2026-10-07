import { describe, it, expect, beforeAll } from "vitest";

import { sql } from "./gov-helpers";

/**
 * `fn_email_tem_conta()` (migration 0188) — o servidor responde o que a pessoa
 * não tem como saber: "este e-mail já tem conta?".
 *
 * O incidente que a originou (B'Laser Gravatá): a tela do convite fazia a
 * pessoa escolher entre login e criar conta, e escolher errado prendia
 * permanentemente. Ver o cabeçalho da migration.
 *
 * Dois grupos de prova aqui: a resposta está CORRETA (senão a tela manda a
 * pessoa para a porta errada, que é o defeito de volta) e a função NÃO é
 * alcançável por quem não deve (senão vira oráculo de enumeração de e-mail do
 * produto inteiro).
 */

const EMAIL_EXISTENTE = "tem-conta@invariant.test";
const EMAIL_APAGADO = "conta-apagada@invariant.test";
const ID_EXISTENTE = "e1a11000-0000-4000-8000-000000000001";
const ID_APAGADO = "e1a11000-0000-4000-8000-000000000002";

function temConta(email: string): string {
  return sql(`select public.fn_email_tem_conta('${email.replace(/'/g, "''")}');`);
}

describe("fn_email_tem_conta — resposta do servidor sobre conta existente (migration 0188)", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values ('${ID_EXISTENTE}', '${EMAIL_EXISTENTE}')
        on conflict do nothing;
      insert into auth.users (id, email, deleted_at)
        values ('${ID_APAGADO}', '${EMAIL_APAGADO}', now())
        on conflict do nothing;
    `);
  });

  it("e-mail cadastrado responde true", () => {
    expect(temConta(EMAIL_EXISTENTE)).toBe("t");
  });

  it("e-mail nunca visto responde false", () => {
    expect(temConta("ninguem-aqui@invariant.test")).toBe("f");
  });

  it("⭐ compara sem diferenciar maiúscula e espaço — a pessoa digita como quiser", () => {
    // O e-mail vem do token do convite, mas o mesmo caminho serve ao signup,
    // onde a digitação é humana. Diferenciar aqui mandaria para a porta errada
    // quem escreveu o próprio e-mail com a primeira letra maiúscula.
    expect(temConta(EMAIL_EXISTENTE.toUpperCase())).toBe("t");
    expect(temConta(`  ${EMAIL_EXISTENTE}  `)).toBe("t");
  });

  it("conta apagada NÃO conta como existente (senão a pessoa é mandada ao login de um fantasma)", () => {
    expect(temConta(EMAIL_APAGADO)).toBe("f");
  });

  it("⭐ não é executável por anon nem por authenticated (seria oráculo de enumeração)", () => {
    // Exposta, esta função responderia "fulano tem conta aqui?" para qualquer
    // um — exatamente o que a anti-enumeração do GoTrue existe para evitar. O
    // baseline tem `GRANT ALL ON FUNCTIONS TO authenticated`, então o revoke
    // explícito das TRÊS origens é o que segura isto.
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_email_tem_conta(text)', 'execute');`),
    ).toBe("f");
    expect(
      sql(
        `select has_function_privilege('authenticated', 'public.fn_email_tem_conta(text)', 'execute');`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select has_function_privilege('service_role', 'public.fn_email_tem_conta(text)', 'execute');`,
      ),
    ).toBe("t");
  });
});
