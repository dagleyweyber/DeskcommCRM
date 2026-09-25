import { describe, expect, it } from "vitest";

import { inviteTokenFromNext } from "./invite-next";

describe("inviteTokenFromNext", () => {
  it("extrai o token de um next de accept-invite", () => {
    expect(inviteTokenFromNext("/team/accept-invite/abcDEF123-_.xyz")).toBe(
      "abcDEF123-_.xyz",
    );
  });

  it("undefined/null/vazio devolve null", () => {
    expect(inviteTokenFromNext(undefined)).toBeNull();
    expect(inviteTokenFromNext(null)).toBeNull();
    expect(inviteTokenFromNext("")).toBeNull();
  });

  it("next que não é de convite devolve null", () => {
    expect(inviteTokenFromNext("/app/inbox")).toBeNull();
    expect(inviteTokenFromNext("/team")).toBeNull();
  });

  it("não casa com segmento extra ou barra final — o alvo é exatamente este path", () => {
    expect(inviteTokenFromNext("/team/accept-invite/tok/extra")).toBeNull();
    expect(inviteTokenFromNext("/team/accept-invite/")).toBeNull();
    expect(inviteTokenFromNext("/team/accept-invite")).toBeNull();
  });

  it("não casa com prefixo diferente — precisa começar exatamente em /team/accept-invite/", () => {
    expect(inviteTokenFromNext("/x/team/accept-invite/tok")).toBeNull();
  });
});
