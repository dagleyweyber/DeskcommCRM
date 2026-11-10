/**
 * O resolvedor de confirmação de agendamento não pode engolir o erro do banco.
 *
 * Caso real (B'Laser Parnamirim, 2026-11-06): a consulta passou do timeout do
 * PostgREST, o `rpc` devolveu `error` e o código tratava isso como "ninguém devido".
 * Nenhum envio falhou, nada foi logado, e a confirmação de Laser ficou parada.
 *
 * 2026-11-10, de novo — e o log sozinho não bastou: ninguém lê log. Desde então o
 * erro LANÇA `FalhaAoResolver`, e o despachante transforma isso em aviso na Central.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { resolvedorDeAgendamento } from "@/lib/automations/triggers/agendamento";
import { FalhaAoResolver } from "@/lib/automations/triggers";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const automacao = { id: "aut-1", organizationId: "org-1" };

function adminCom(resposta: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => resposta) } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("resolvedorDeAgendamento", () => {
  it("⭐ erro do banco (timeout) LANÇA e é registrado — nunca vira 'ninguém devido'", async () => {
    const admin = adminCom({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    const promessa = resolvedorDeAgendamento.resolve(admin, automacao, new Date());
    await expect(promessa).rejects.toBeInstanceOf(FalhaAoResolver);
    await expect(promessa).rejects.toMatchObject({ codigo: "57014" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls[0]![1]).toMatchObject({
      automation_id: "aut-1",
      organization_id: "org-1",
      code: "57014",
    });
  });

  it("resposta vazia sem erro não gera log", async () => {
    const admin = adminCom({ data: [], error: null });
    expect(await resolvedorDeAgendamento.resolve(admin, automacao, new Date())).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("traduz as linhas devidas", async () => {
    const admin = adminCom({
      data: [
        {
          lead_id: null,
          contact_id: "c-1",
          activity_id: "ap-1",
          scheduled_at: "2026-11-07T12:00:00Z",
          display_name: "Ana",
        },
      ],
      error: null,
    });
    expect(await resolvedorDeAgendamento.resolve(admin, automacao, new Date())).toEqual([
      {
        leadId: null,
        contactId: "c-1",
        displayName: "Ana",
        occurrenceKey: "ap-1",
        appointmentAt: "2026-11-07T12:00:00Z",
        appointmentId: "ap-1",
      },
    ]);
  });
});
