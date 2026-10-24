import { describe, expect, it } from "vitest";

import { avisoDoAccountUpdate, detalheDaDesconexao, saudeDoAccountUpdate } from "./account-update";
import type { AccountUpdateEvent } from "./coexistence-webhook";

const ev = (p: Partial<AccountUpdateEvent>): AccountUpdateEvent => ({
  kind: "account_update",
  wabaId: "W1",
  event: "X",
  banState: null,
  disconnectReason: null,
  disconnectInitiatedBy: null,
  violationType: null,
  restrictionType: null,
  ...p,
});

describe("saudeDoAccountUpdate — quando a conexão CAIU", () => {
  it.each(["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED", "ACCOUNT_OFFBOARDED", "ACCOUNT_DELETED"])(
    "%s → STOPPED (a conta deixou de existir para o CRM)",
    (event) => {
      expect(saudeDoAccountUpdate(ev({ event }))).toMatchObject({ reachable: true, status: "STOPPED" });
    },
  );

  it("banimento (DISABLE e SCHEDULE_FOR_DISABLE) → FAILED; REINSTATE → WORKING", () => {
    expect(saudeDoAccountUpdate(ev({ event: "DISABLED_UPDATE", banState: "DISABLE" }))?.status).toBe("FAILED");
    expect(
      saudeDoAccountUpdate(ev({ event: "DISABLED_UPDATE", banState: "SCHEDULE_FOR_DISABLE" }))?.status,
    ).toBe("FAILED");
    expect(saudeDoAccountUpdate(ev({ event: "DISABLED_UPDATE", banState: "REINSTATE" }))?.status).toBe("WORKING");
  });

  it("ACCOUNT_VIOLATION → FAILED; ACCOUNT_RECONNECTED → WORKING (é o que fecha o episódio)", () => {
    expect(saudeDoAccountUpdate(ev({ event: "ACCOUNT_VIOLATION" }))?.status).toBe("FAILED");
    expect(saudeDoAccountUpdate(ev({ event: "ACCOUNT_RECONNECTED" }))?.status).toBe("WORKING");
  });

  it("⭐ o que NÃO derruba o envio não vira queda (a faixa vermelha não pode acender à toa)", () => {
    for (const event of [
      "ACCOUNT_RESTRICTION",
      "PARTNER_ADDED",
      "PARTNER_APP_INSTALLED",
      "VOLUME_BASED_PRICING_TIER_UPDATE",
      "AD_ACCOUNT_LINKED",
    ]) {
      expect(saudeDoAccountUpdate(ev({ event }))).toBeNull();
    }
    // estado de ban que não conhecemos também não vira queda
    expect(saudeDoAccountUpdate(ev({ event: "DISABLED_UPDATE", banState: "OUTRO" }))).toBeNull();
  });
});

describe("avisoDoAccountUpdate — atenção SEM queda", () => {
  it("restrição vira aviso `warn`, nunca crítico", () => {
    const a = avisoDoAccountUpdate(ev({ event: "ACCOUNT_RESTRICTION", restrictionType: "ABC" }));
    expect(a).toMatchObject({ kind: "channel_number_alert", severity: "warn" });
    expect(a!.body).toContain("ABC");
  });

  it("⭐ queda NÃO gera também um aviso avulso (a Central mostraria o mesmo problema duas vezes)", () => {
    expect(avisoDoAccountUpdate(ev({ event: "PARTNER_REMOVED" }))).toBeNull();
    expect(avisoDoAccountUpdate(ev({ event: "DISABLED_UPDATE", banState: "DISABLE" }))).toBeNull();
  });
});

describe("detalheDaDesconexao — o motivo em português de recepção", () => {
  it("celular parado ~14 dias explica o que fazer", () => {
    const t = detalheDaDesconexao(
      ev({ event: "PARTNER_REMOVED", disconnectReason: "PRIMARY_INACTIVITY", disconnectInitiatedBy: "SYSTEM" }),
    );
    expect(t).toContain("14 dias");
    expect(t).toContain("automaticamente pela Meta");
  });

  it("motivo desconhecido repete o código, sem inventar explicação", () => {
    expect(
      detalheDaDesconexao(ev({ event: "PARTNER_REMOVED", disconnectReason: "NOVO_MOTIVO" })),
    ).toContain("NOVO_MOTIVO");
  });

  it("só PARTNER_REMOVED tem motivo", () => {
    expect(detalheDaDesconexao(ev({ event: "ACCOUNT_OFFBOARDED", disconnectReason: "X" }))).toBeNull();
  });
});
