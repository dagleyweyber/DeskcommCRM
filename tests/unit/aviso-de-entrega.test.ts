import { describe, expect, it, vi } from "vitest";

import { registrarEntregaFalhada } from "@/lib/automations/aviso-de-entrega";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

/** Dublê mínimo: cada tabela devolve a linha combinada; escritas ficam registradas. */
function banco(tabelas: Record<string, unknown>, jaAvisado = false) {
  const escritas: { tabela: string; op: string; valores: unknown }[] = [];
  const admin = {
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      const cadeia = () => q;
      for (const m of ["select", "eq", "limit"]) q[m] = cadeia;
      q.maybeSingle = async () => ({
        data: tabela === "agent_inbox_items" ? (jaAvisado ? { id: "x" } : null) : (tabelas[tabela] ?? null),
        error: null,
      });
      q.update = (valores: unknown) => {
        escritas.push({ tabela, op: "update", valores });
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.then = (ok: (v: unknown) => void) => ok({ error: null });
        return u;
      };
      q.insert = async (valores: unknown) => {
        escritas.push({ tabela, op: "insert", valores });
        return { error: null };
      };
      return q;
    },
  };
  return { admin: admin as never, escritas };
}

const envio = { id: "e1", status: "sent", contact_id: "c1", appointment_id: "a1", automation_id: "au1" };
const base = {
  whatsapp_template_automation_sends: envio,
  contacts: { display_name: "DANYELLE", name: null, phone_number: "+5581915765003" },
  calendar_appointments: { starts_at: "2026-11-12T20:00:00Z", time_zone: "America/Sao_Paulo" },
  whatsapp_template_automations: { name: "Confirmação_Agenda_Corporal" },
};

describe("registrarEntregaFalhada", () => {
  it("⭐ envio de automação que a Meta não entregou: vira 'failed' e abre UM aviso com nome, número e motivo", async () => {
    const { admin, escritas } = banco(base);
    expect(await registrarEntregaFalhada(admin, "org", "wamid.1", "Message undeliverable")).toBe("aviso_aberto");
    const upd = escritas.find((e) => e.tabela === "whatsapp_template_automation_sends");
    expect(upd?.valores).toMatchObject({ status: "failed" });
    const aviso = escritas.find((e) => e.tabela === "agent_inbox_items")?.valores as Record<string, string>;
    expect(aviso.title).toContain("DANYELLE");
    expect(aviso.body).toContain("+5581915765003");
    expect(aviso.body).toContain("Message undeliverable");
    expect(aviso.ref_id).toBe("e1");
  });

  it("mensagem que não é de automação (conversa, campanha) é ignorada", async () => {
    const { admin, escritas } = banco({ ...base, whatsapp_template_automation_sends: null });
    expect(await registrarEntregaFalhada(admin, "org", "wamid.2", null)).toBe("sem_envio_de_automacao");
    expect(escritas).toHaveLength(0);
  });

  it("⭐ o mesmo envio avisado de novo (Meta repete o webhook) não abre segundo aviso", async () => {
    const { admin, escritas } = banco(base, true);
    expect(await registrarEntregaFalhada(admin, "org", "wamid.1", "x")).toBe("ja_avisado");
    expect(escritas.some((e) => e.tabela === "agent_inbox_items")).toBe(false);
  });
});
