import { describe, expect, it } from "vitest";

import { LEAD_SOURCES, sourceLabel } from "./lead-form-shared";

describe("sourceLabel", () => {
  it("traduz toda origem oferecida no seletor manual", () => {
    for (const s of LEAD_SOURCES) {
      expect(sourceLabel(s.value)).toBe(s.label);
    }
  });

  it("⭐ origens que só o SISTEMA grava (nunca num seletor manual) também têm rótulo", () => {
    // "whatsapp": nascimento-do-lead.ts. "automation": create-or-move-lead.ts.
    expect(sourceLabel("whatsapp")).toBe("WhatsApp");
    expect(sourceLabel("automation")).toBe("Automação");
  });

  it("origem desconhecida (vocabulário aberto) devolve o valor cru, não quebra", () => {
    expect(sourceLabel("algum_valor_novo")).toBe("algum_valor_novo");
  });
});
