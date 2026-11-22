import { describe, expect, it, vi } from "vitest";

import { completarPeloZandu, traduzirAviso } from "@/lib/agenda-externa/avisos";
import type { Integracao } from "@/lib/agenda-externa/sincronizar";
import type { ClienteZandu } from "@/lib/agenda-externa/zandu/api";

/**
 * O aviso real do Zandu (RevitaFio Mossoró, 2026-11-22) chegou só com códigos e foi
 * descartado como "sem celular" em potencial. O processamento completa pela API do
 * próprio Zandu: pessoa (nome + celular), catálogo (nome do serviço) e agendas (sala).
 */
const aviso = () =>
  traduzirAviso("zandu", {
    data: [
      {
        appointmentId: "ag-1",
        start: "2026-11-23T13:00:00.000Z",
        end: "2026-11-23T13:10:00.000Z",
        status: "agendamento_criado",
        personId: "pessoa-1",
        scheduleId: "agenda-1",
        items: [{ serviceId: "serv-1" }],
      },
    ],
    event: { lastEvent: "agendamento_criado", content: "Avaliação " },
  });

function clienteFalso(): ClienteZandu & { pessoa: ReturnType<typeof vi.fn> } {
  return {
    conferirToken: vi.fn(),
    pessoa: vi.fn().mockResolvedValue({ personId: "pessoa-1", name: "Ana Paciente", phone: "5584987650000", phone2: "" }),
    servicos: vi.fn().mockResolvedValue(new Map([["serv-1", "2 - Reprogramação Capilar "]])),
    agendas: vi.fn().mockResolvedValue(new Map([["agenda-1", "Sala 1"]])),
  };
}

const integ = (id: string) => ({ id, organization_id: "org-1", provider: "zandu" }) as Integracao;

describe("completar o aviso do Zandu pela API", () => {
  it("⭐ nome e celular da pessoa, nome do serviço (sem o número do catálogo) e nome da agenda", async () => {
    const a = aviso();
    await completarPeloZandu({} as never, integ("integ-a"), a, new Date("2026-11-22T01:10:00Z"), clienteFalso());
    expect(a.itens[0]!.item).toMatchObject({
      titulo: "Reprogramação Capilar",
      tipo: { chave: "servico:reprogramacao capilar", rotulo: "Reprogramação Capilar" },
      salaCodigo: "agenda-1",
      salaNome: "Sala 1",
    });
    expect(a.itens[0]!.item.cliente).toMatchObject({ nome: "Ana Paciente", celular: "5584987650000" });
  });

  it("catálogo e agendas vêm do cache na 2ª vez (limite de consultas do Zandu)", async () => {
    const cliente = clienteFalso();
    const agora = new Date("2026-11-22T01:10:00Z");
    await completarPeloZandu({} as never, integ("integ-b"), aviso(), agora, cliente);
    await completarPeloZandu({} as never, integ("integ-b"), aviso(), new Date(agora.getTime() + 5 * 60_000), cliente);
    expect(cliente.servicos).toHaveBeenCalledTimes(1);
    expect(cliente.agendas).toHaveBeenCalledTimes(1);
    expect(cliente.pessoa).toHaveBeenCalledTimes(2);
  });

  it("pessoa não encontrada: segue sem celular (vira 'sem celular', não inventa)", async () => {
    const cliente = clienteFalso();
    cliente.pessoa.mockResolvedValue(null);
    const a = aviso();
    await completarPeloZandu({} as never, integ("integ-c"), a, new Date(), cliente);
    expect(a.itens[0]!.item.cliente.celular).toBe("");
  });
});
