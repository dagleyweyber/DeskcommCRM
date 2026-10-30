import { beforeEach, describe, expect, it, vi } from "vitest";

import { registrarRespostaDeConfirmacao } from "@/lib/agenda/confirmacao";

const devolver = vi.fn();
vi.mock("@/lib/agenda-externa/devolver-confirmacao", () => ({
  devolverConfirmacaoDoCompromisso: (...a: unknown[]) => devolver(...a),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "org-1";
const COMPROMISSO = { id: "ap-1", status: "pending", starts_at: "2026-11-01T13:00:00Z", revision: 2, contact_id: "c-1" };

/** Admin falso: cada tabela responde com a linha que a cadeia da confirmação espera. */
function adminFalso() {
  const linhas: Record<string, unknown> = {
    whatsapp_template_automation_sends: { automation_id: "au-1", appointment_id: "ap-1" },
    whatsapp_template_automations: { confirm_button_text: "Confirmo presença", decline_button_text: "Preciso remarcar" },
    calendar_appointments: COMPROMISSO,
    contacts: { display_name: "Paciente", phone_number: "+5581999990000" },
  };
  const construtor = (tabela: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "ap-1" }, error: null }) }) }) }) }) }),
      insert: () => Promise.resolve({ error: null }),
      maybeSingle: () => Promise.resolve({ data: linhas[tabela] ?? null }),
    };
    return q;
  };
  return { from: construtor } as never;
}

const resposta = (texto: string) => ({ organizationId: ORG, respondeuA: "wamid.X", texto, payload: null });

beforeEach(() => devolver.mockReset());

describe("resposta do cliente → Belle", () => {
  it("⭐ 'Confirmo presença' devolve a confirmação ao Belle", async () => {
    const r = await registrarRespostaDeConfirmacao(adminFalso(), resposta("Confirmo presença"));
    expect(r).toMatchObject({ resultado: "atualizado", status: "confirmed" });
    expect(devolver).toHaveBeenCalledWith(expect.anything(), ORG, "ap-1");
  });

  it("'Preciso remarcar' NÃO escreve no Belle (não libera a vaga)", async () => {
    const r = await registrarRespostaDeConfirmacao(adminFalso(), resposta("Preciso remarcar"));
    expect(r).toMatchObject({ resultado: "atualizado", status: "declined" });
    expect(devolver).not.toHaveBeenCalled();
  });

  it("texto livre não devolve nada", async () => {
    const r = await registrarRespostaDeConfirmacao(adminFalso(), resposta("sim, pode ser"));
    expect(r.resultado).toBe("ignorado");
    expect(devolver).not.toHaveBeenCalled();
  });
});
