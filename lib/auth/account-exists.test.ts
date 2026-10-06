import { describe, expect, it } from "vitest";

import { accountExistsForEmail, type AdminAuthListUsers } from "./account-exists";

function fakeAdmin(
  users: Array<{ email?: string | null }>,
  opts?: { error?: boolean },
): AdminAuthListUsers {
  return {
    auth: {
      admin: {
        listUsers: async () =>
          opts?.error ? { data: null, error: new Error("boom") } : { data: { users }, error: null },
      },
    },
  };
}

describe("accountExistsForEmail", () => {
  it("encontra o e-mail (case-insensitive, com espaço nas pontas)", async () => {
    const admin = fakeAdmin([{ email: "Melissa@Botulaser.com" }]);
    await expect(accountExistsForEmail(admin, "  melissa@botulaser.com  ")).resolves.toBe(true);
  });

  it("não encontra quando nenhum usuário bate", async () => {
    const admin = fakeAdmin([{ email: "outra@pessoa.com" }]);
    await expect(accountExistsForEmail(admin, "melissa@botulaser.com")).resolves.toBe(false);
  });

  it("e-mail vazio devolve null sem chamar a API", async () => {
    const admin = fakeAdmin([]);
    await expect(accountExistsForEmail(admin, "   ")).resolves.toBeNull();
  });

  it("erro na API devolve null — nunca lança, quem chama degrada pra 'não sei'", async () => {
    const admin = fakeAdmin([], { error: true });
    await expect(accountExistsForEmail(admin, "melissa@botulaser.com")).resolves.toBeNull();
  });

  it("usuário sem e-mail (null) não quebra a busca", async () => {
    const admin = fakeAdmin([{ email: null }, { email: "melissa@botulaser.com" }]);
    await expect(accountExistsForEmail(admin, "melissa@botulaser.com")).resolves.toBe(true);
  });
});
