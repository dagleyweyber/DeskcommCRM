import { describe, expect, it } from "vitest";

import { instante, statusPorTexto, telefoneNoObjeto } from "@/lib/agenda-externa/aviso-comum";
import { telefoneDoBelle } from "@/lib/agenda-externa/belle/traduzir";
import { traduzirAvisoDoUno } from "@/lib/agenda-externa/uno/traduzir";
import { traduzirAvisoDoZandu } from "@/lib/agenda-externa/zandu/traduzir";

/** O exemplo da documentação do Uno (readme.unobject.com.br/reference/webhook), literal. */
const AVISO_UNO = {
  event: "APPOINTMENT_UPDATED",
  schema: "empresa_x",
  appointment: {
    id: 123,
    startDate: "2026-08-19T14:30:00-03:00",
    endDate: "2026-08-19T15:30:00-03:00",
    observation: "Observação do agendamento ou null",
    serviceSession: 1,
    status: { id: 5, name: "Atendido" },
    customer: { id: 10, name: "Maria Silva" },
    employee: { id: 4, name: "João Souza" },
    room: { id: 2, name: "Sala 2" },
    service: { id: 7, name: "Limpeza de pele" },
  },
};

describe("Uno → Agenda", () => {
  it("⭐ o exemplo documentado vira o agendamento, no instante certo (fuso da empresa → UTC)", () => {
    const r = traduzirAvisoDoUno(AVISO_UNO);
    expect(r.conta).toBe("empresa_x");
    expect(r.externalId).toBe("123");
    expect(r.item).toMatchObject({
      externalId: "123",
      startsAt: "2026-08-19T17:30:00.000Z",
      endsAt: "2026-08-19T18:30:00.000Z",
      status: "completed",
      statusExterno: "Atendido",
      salaCodigo: "2",
      salaNome: "Sala 2",
      titulo: "Limpeza de pele",
      tipo: { chave: "servico:limpeza de pele", rotulo: "Limpeza de pele" },
    });
    expect(r.item?.cliente).toMatchObject({ codigo: "10", nome: "Maria Silva" });
  });

  it("⭐ o Uno documenta o cliente SEM celular: o item sai com celular vazio (vira 'sem celular', não um contato inventado)", () => {
    expect(traduzirAvisoDoUno(AVISO_UNO).item?.cliente.celular).toBe("");
  });

  it("se o Uno mandar o celular a mais no cliente, ele é aproveitado", () => {
    const r = traduzirAvisoDoUno({
      ...AVISO_UNO,
      appointment: { ...AVISO_UNO.appointment, customer: { id: 10, name: "Maria", cellPhone: "(81) 98756-1002" } },
    });
    expect(telefoneDoBelle(r.item!.cliente.celular, null)).toBe("+5581987561002");
  });

  it("⭐ remoção vira cancelado 'Removido' — o horário volta a ficar livre", () => {
    const r = traduzirAvisoDoUno({ ...AVISO_UNO, event: "APPOINTMENT_REMOVED" });
    expect(r.item).toMatchObject({ status: "cancelled", statusExterno: "Removido" });
  });

  it("venda (ORDER_*) não é agendamento: nada a aplicar", () => {
    const r = traduzirAvisoDoUno({ event: "ORDER_CREATED", schema: "x", order: { id: 1 } });
    expect(r.item).toBeNull();
    expect(r.motivo).toMatch(/não é aviso de agendamento/);
  });

  it("sem data não aplica (não chuta horário)", () => {
    const r = traduzirAvisoDoUno({ event: "APPOINTMENT_CREATED", appointment: { id: 9 } });
    expect(r.item).toBeNull();
    expect(r.externalId).toBe("9");
  });

  it("sem fim, usa a duração padrão", () => {
    const { endDate: _sem, ...semFim } = AVISO_UNO.appointment;
    const r = traduzirAvisoDoUno({ ...AVISO_UNO, appointment: semFim });
    expect(r.item?.endsAt).toBe("2026-08-19T18:00:00.000Z");
  });
});

describe("Zandu → Agenda (formato da própria API; o webhook não é documentado)", () => {
  const AG = {
    appointmentId: "7a56c83c-2031-411a-aa5e-ea9000000000",
    personId: "e2af0a11-f9dc-44f5-b453-021400000000",
    personPhone: "5584987654321",
    personName: "João da Silva",
    scheduleId: "d2804165-456e-4ea2-ab0f-554c00000000",
    start: "2026-11-25T17:45:00.000Z",
    durationMinutes: 45,
    notes: "Anotações",
    items: [{ serviceId: "4033ef40", service: { name: "Depilação a Laser" } }],
    status: "Confirmado",
  };

  it("⭐ agendamento no topo do corpo", () => {
    const r = traduzirAvisoDoZandu({ event: "appointment.created", ...AG });
    expect(r.item).toMatchObject({
      externalId: AG.appointmentId,
      startsAt: "2026-11-25T17:45:00.000Z",
      endsAt: "2026-11-25T18:30:00.000Z",
      status: "confirmed",
      titulo: "Depilação a Laser",
      salaCodigo: AG.scheduleId,
    });
    expect(r.item?.cliente).toMatchObject({ nome: "João da Silva", celular: "5584987654321" });
    expect(r.pessoaId).toBe(AG.personId);
  });

  it("⭐ agendamento embrulhado em `data` e data SEM fuso lida como UTC (como a API do Zandu)", () => {
    const r = traduzirAvisoDoZandu({ event: "appointment.updated", data: { ...AG, start: "2026-11-25T17:45:00.000" } });
    expect(r.item?.startsAt).toBe("2026-11-25T17:45:00.000Z");
  });

  it("evento de remoção vira cancelado 'Removido'", () => {
    const r = traduzirAvisoDoZandu({ event: "appointment.deleted", data: AG });
    expect(r.item).toMatchObject({ status: "cancelled", statusExterno: "Removido" });
  });

  it("evento de cancelamento sem status no corpo vira cancelado", () => {
    const { status: _s, ...semStatus } = AG;
    const r = traduzirAvisoDoZandu({ event: "appointment.canceled", data: semStatus });
    expect(r.item?.status).toBe("cancelled");
  });

  it("sem celular no aviso, guarda o personId para buscar a pessoa", () => {
    const { personPhone: _p, ...semFone } = AG;
    const r = traduzirAvisoDoZandu({ data: semFone });
    expect(r.item?.cliente.celular).toBe("");
    expect(r.pessoaId).toBe(AG.personId);
  });

  it("corpo sem agendamento reconhecível não aplica", () => {
    expect(traduzirAvisoDoZandu({ hello: "world" }).item).toBeNull();
  });
});

describe("peças comuns", () => {
  it.each([
    ["Agendado", "pending"],
    ["Não confirmado", "pending"],
    ["Confirmado", "confirmed"],
    ["Check-in", "confirmed"],
    ["Em atendimento", "confirmed"],
    ["Atendido", "completed"],
    ["Falta", "no_show"],
    ["Faltou", "no_show"],
    ["Cancelado pelo cliente", "cancelled"],
    ["Desmarcado", "cancelled"],
    ["Algum status novo", "pending"],
    ["", "pending"],
  ])("status %s → %s", (texto, esperado) => {
    expect(statusPorTexto(texto)).toBe(esperado);
  });

  it("celular antes do fixo", () => {
    expect(telefoneNoObjeto({ phone: "8433334444", cellPhone: "84987654321" })).toBe("84987654321");
  });

  it("data sem fuso: inválida por padrão, UTC quando pedido", () => {
    expect(instante("2026-11-25T10:00:00")).toBeNull();
    expect(instante("2026-11-25T10:00:00", "utc")).toBe("2026-11-25T10:00:00.000Z");
    expect(instante("2026-11-25T10:00:00-03:00")).toBe("2026-11-25T13:00:00.000Z");
  });
});
