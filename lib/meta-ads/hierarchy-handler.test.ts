import { describe, expect, it } from "vitest";

import { metaAdsHierarchyHandler } from "./hierarchy-handler";

describe("metaAdsHierarchyHandler — quais eventos disparam a resolução", () => {
  it("⭐ escuta lead.reactivated além de lead.created", () => {
    // Achado ao vivo: a janela de reativação (nascimento-do-lead.ts) pode
    // reabrir uma demanda com um clique de anúncio NOVO (source_metadata
    // atualizado) — sem escutar lead.reactivated, essa campanha nunca
    // seria resolvida, diferente de um lead genuinamente novo com o mesmo
    // ad_id.
    expect(metaAdsHierarchyHandler.events).toContain("lead.created");
    expect(metaAdsHierarchyHandler.events).toContain("lead.reactivated");
  });
});
