import { describe, expect, it } from "vitest";

import { instante, statusPorTexto, telefoneNoObjeto } from "@/lib/agenda-externa/aviso-comum";
import { telefoneDoBelle } from "@/lib/agenda-externa/belle/traduzir";
import { traduzirAvisoDoUno } from "@/lib/agenda-externa/uno/traduzir";
import { codigoSemDetalhe, nomeDoServico, statusLegivel, traduzirAvisoDoZandu } from "@/lib/agenda-externa/zandu/traduzir";

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
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0]!.item).toMatchObject({
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
    expect(r.itens[0]!.item.cliente).toMatchObject({ codigo: "10", nome: "Maria Silva" });
  });

  it("⭐ o Uno documenta o cliente SEM celular: o item sai com celular vazio (vira 'sem celular', não um contato inventado)", () => {
    expect(traduzirAvisoDoUno(AVISO_UNO).itens[0]!.item.cliente.celular).toBe("");
  });

  it("se o Uno mandar o celular a mais no cliente, ele é aproveitado", () => {
    const r = traduzirAvisoDoUno({
      ...AVISO_UNO,
      appointment: { ...AVISO_UNO.appointment, customer: { id: 10, name: "Maria", cellPhone: "(81) 98756-1002" } },
    });
    expect(telefoneDoBelle(r.itens[0]!.item.cliente.celular, null)).toBe("+5581987561002");
  });

  it("⭐ remoção vira cancelado 'Removido' — o horário volta a ficar livre", () => {
    const r = traduzirAvisoDoUno({ ...AVISO_UNO, event: "APPOINTMENT_REMOVED" });
    expect(r.itens[0]!.item).toMatchObject({ status: "cancelled", statusExterno: "Removido" });
  });

  it("venda (ORDER_*) não é agendamento: nada a aplicar", () => {
    const r = traduzirAvisoDoUno({ event: "ORDER_CREATED", schema: "x", order: { id: 1 } });
    expect(r.itens).toEqual([]);
    expect(r.motivo).toMatch(/não é aviso de agendamento/);
  });

  it("sem data não aplica (não chuta horário)", () => {
    const r = traduzirAvisoDoUno({ event: "APPOINTMENT_CREATED", appointment: { id: 9 } });
    expect(r.itens).toEqual([]);
    expect(r.externalId).toBe("9");
  });

  it("sem fim, usa a duração padrão", () => {
    const { endDate: _sem, ...semFim } = AVISO_UNO.appointment;
    const r = traduzirAvisoDoUno({ ...AVISO_UNO, appointment: semFim });
    expect(r.itens[0]!.item.endsAt).toBe("2026-08-19T18:00:00.000Z");
  });
});

/**
 * O 1º aviso REAL do Zandu (RevitaFio Mossoró, 2026-11-22), com os campos que importam.
 * Códigos trocados; a forma é a medida. O aviso não traz nome, celular, nome do serviço
 * nem nome da agenda — só os códigos.
 */
const AG_REAL = {
  end: "2026-11-23T13:10:00.000Z",
  items: [{ pos: 0, price: 0, serviceId: "serv-avaliacao", appointmentId: "ag-1", appointmentItemId: "it-1" }],
  notes: "",
  start: "2026-11-23T13:00:00.000Z",
  source: "erp",
  status: "agendamento_criado",
  personId: "pessoa-1",
  companyId: "empresa-1",
  scheduleId: "agenda-avaliacao",
  appointmentId: "ag-1",
};
const EVENTO_REAL = {
  status: 100,
  source: "agenda",
  content: "Avaliação ",
  personId: "pessoa-1",
  companyId: "empresa-1",
  lastEvent: "agendamento_criado",
  externalId: "ag-1",
  externalDate: "2026-11-23T13:00:00.000Z",
};
const AVISO_ZANDU_REAL = { data: [AG_REAL], event: EVENTO_REAL, param: "" };

describe("Zandu → Agenda (formato medido no 1º aviso real)", () => {
  it("⭐ o aviso real vira o agendamento, com os códigos para completar pela API", () => {
    const r = traduzirAvisoDoZandu(AVISO_ZANDU_REAL);
    expect(r.evento).toBe("agendamento_criado");
    expect(r.externalId).toBe("ag-1");
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0]).toMatchObject({ pessoaId: "pessoa-1", servicoIds: ["serv-avaliacao"] });
    expect(r.itens[0]!.item).toMatchObject({
      externalId: "ag-1",
      startsAt: "2026-11-23T13:00:00.000Z",
      endsAt: "2026-11-23T13:10:00.000Z",
      status: "pending",
      statusExterno: "Agendamento criado",
      salaCodigo: "agenda-avaliacao",
      salaNome: "",
      // Até o catálogo responder, vale o `event.content`.
      titulo: "Avaliação",
      notas: null,
    });
    // Nome e celular vêm de /persons/{id} no processamento.
    expect(r.itens[0]!.item.cliente).toMatchObject({ codigo: "pessoa-1", nome: "", celular: "" });
  });

  it("⭐ `data` com dois agendamentos → dois itens", () => {
    const outro = { ...AG_REAL, appointmentId: "ag-2", start: "2026-11-23T14:00:00.000Z", end: "2026-11-23T14:30:00.000Z" };
    const r = traduzirAvisoDoZandu({ ...AVISO_ZANDU_REAL, data: [AG_REAL, outro] });
    expect(r.itens.map((i) => i.item.externalId)).toEqual(["ag-1", "ag-2"]);
  });

  it.each([
    ["agendamento_confirmado", "confirmed"],
    ["agendamento_cancelado", "cancelled"],
    ["agendamento_finalizado", "completed"],
    ["agendamento_falta", "no_show"],
  ])("status %s → %s", (status, esperado) => {
    const r = traduzirAvisoDoZandu({ data: [{ ...AG_REAL, status }], event: { ...EVENTO_REAL, lastEvent: status } });
    expect(r.itens[0]!.item.status).toBe(esperado);
  });

  it("evento de remoção vira cancelado 'Removido'", () => {
    const r = traduzirAvisoDoZandu({ data: [AG_REAL], event: { ...EVENTO_REAL, lastEvent: "agendamento_removido" } });
    expect(r.itens[0]!.item).toMatchObject({ status: "cancelled", statusExterno: "Removido" });
  });

  it("aviso sem agendamento reconhecível não aplica (e não quebra)", () => {
    const r = traduzirAvisoDoZandu({ data: [], event: { lastEvent: "pessoa_criada" } });
    expect(r.itens).toEqual([]);
    expect(r.motivo).toMatch(/sem código ou sem data/);
  });

  it("⭐ aviso de CONFIRMAÇÃO (medido 2026-11-23) vem sem `data`: diz o código a buscar", () => {
    const confirmacao = { event: { ...EVENTO_REAL, lastEvent: "agendamento_confirmado" }, param: "" };
    expect(traduzirAvisoDoZandu(confirmacao).itens).toEqual([]);
    expect(codigoSemDetalhe(confirmacao)).toBe("ag-1");
    expect(codigoSemDetalhe(AVISO_ZANDU_REAL)).toBeNull();
  });

  it("compareceu → atendido; horário bloqueado não vira agendamento", () => {
    const veio = traduzirAvisoDoZandu({ data: [{ ...AG_REAL, status: "agendamento_compareceu" }], event: {} });
    expect(veio.itens[0]!.item.status).toBe("completed");
    const bloqueio = traduzirAvisoDoZandu({ data: [{ ...AG_REAL, status: "agendamento_bloqueado" }], event: {} });
    expect(bloqueio.itens).toEqual([]);
  });

  it("nomes do Zandu: status legível e número do catálogo fora", () => {
    expect(statusLegivel("agendamento_criado")).toBe("Agendamento criado");
    expect(nomeDoServico("1 - Avaliação")).toBe("Avaliação");
    expect(nomeDoServico("Reprogramação Capilar ")).toBe("Reprogramação Capilar");
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
