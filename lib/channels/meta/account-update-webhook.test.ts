import { describe, expect, it } from "vitest";

import { parseMetaWebhook } from "./webhook";

const conta = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W1", changes: [{ field: "account_update", value }] }],
});

describe("account_update — os avisos da CONTA", () => {
  it("PARTNER_REMOVED traz o motivo e quem desconectou", () => {
    const [e] = parseMetaWebhook(
      conta({
        event: "PARTNER_REMOVED",
        waba_info: { waba_id: "W9", owner_business_id: "B1" },
        disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" },
      }),
    );
    expect(e).toMatchObject({
      kind: "account_update",
      event: "PARTNER_REMOVED",
      wabaId: "W9", // o `waba_info.waba_id` manda sobre o `entry.id`
      disconnectReason: "PRIMARY_INACTIVITY",
      disconnectInitiatedBy: "SYSTEM",
    });
  });

  it("DISABLED_UPDATE: waba_ban_state pode vir como lista (a doc da Meta mostra array)", () => {
    const [e] = parseMetaWebhook(
      conta({
        event: "DISABLED_UPDATE",
        ban_info: { waba_ban_state: ["SCHEDULE_FOR_DISABLE"], waba_ban_date: "x" },
      }),
    );
    expect(e).toMatchObject({
      kind: "account_update",
      event: "DISABLED_UPDATE",
      banState: "SCHEDULE_FOR_DISABLE",
      wabaId: "W1",
    });
  });

  it("DISABLED_UPDATE com estado em texto simples também é lido", () => {
    const [e] = parseMetaWebhook(
      conta({ event: "DISABLED_UPDATE", ban_info: { waba_ban_state: "REINSTATE" } }),
    );
    expect(e).toMatchObject({ banState: "REINSTATE" });
  });

  it("ACCOUNT_RESTRICTION e ACCOUNT_VIOLATION guardam só o tipo", () => {
    const [r] = parseMetaWebhook(
      conta({
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [{ restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION", expiration: 1 }],
      }),
    );
    const [v] = parseMetaWebhook(
      conta({ event: "ACCOUNT_VIOLATION", violation_info: { violation_type: "SPAM" } }),
    );
    expect(r).toMatchObject({ restrictionType: "RESTRICTED_ADD_PHONE_NUMBER_ACTION" });
    expect(v).toMatchObject({ violationType: "SPAM" });
  });

  it("sem `event` não vira nada (payload capenga)", () => {
    expect(parseMetaWebhook(conta({ waba_info: {} }))).toEqual([]);
  });
});
