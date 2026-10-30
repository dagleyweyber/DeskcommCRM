/**
 * Tradução Belle → Agenda. Os casos vêm de dados REAIS medidos na B'Laser
 * Parnamirim (2026-10-29), com nomes e telefones trocados.
 */
import { describe, expect, it } from "vitest";

import type { AgendamentoDaLista, LinhaDoRelatorio } from "@/lib/agenda-externa/belle/api";
import {
  catalogoPorCodigo,
  chaveDoNome,
  sugerirServico,
  tipoDoAgendamento,
  tipoDoCatalogo,
  dddDoTelefone,
  juntarAgendamentos,
  statusDoBelle,
  telefoneDoBelle,
  variantesDoTelefone,
} from "@/lib/agenda-externa/belle/traduzir";
import { statusFinal } from "@/lib/agenda-externa/sincronizar";

const TZ = "America/Sao_Paulo";

function linha(over: Partial<LinhaDoRelatorio> = {}): LinhaDoRelatorio {
  return {
    idAgendamento: "74162300",
    dataAgendamento: "29/10/2026",
    horarioAgendamento: "10:00",
    minutosAgendamento: 35,
    codigoCliente: "8606065",
    nomeCliente: "PACIENTE TESTE",
    salaAgendamento: "Laser 01",
    codigoServico: "33452277",
    nomeServico: "F. Glúteos Médios",
    tipoAgendamento: "Serviço",
    statusAgendamento: "Atendido",
    ...over,
  };
}

function lista(over: Partial<AgendamentoDaLista> = {}): AgendamentoDaLista {
  return {
    codConsulta: "74162300",
    dtAgenda: "29/10/2026",
    hrConsulta: "10:00",
    status: "Atendido",
    tipo: "Serviço",
    observacao: "COM ROSI",
    cliente: { cod: "8606065", nome: "PACIENTE TESTE", celular: "(81)98756-1002" },
    sala: { cod: "24142", nome: "Laser 01" },
    servicos: [
      { cod: "33452277", nome: "F. Glúteos Médios " },
      { cod: " 33452300", nome: "F. Virilha Completa ou Cavada " },
    ],
    ...over,
  };
}

describe("status do Belle", () => {
  it.each([
    ["Marcado", "pending"],
    ["Aguardando", "pending"],
    ["Antecipado", "pending"],
    ["Confirmado", "confirmed"],
    ["Em Andamento", "confirmed"],
    ["Atendido", "completed"],
    ["Falhou", "no_show"],
    ["Desmarcado", "cancelled"],
    ["Cancelado", "cancelled"],
  ])("%s → %s", (belle, crm) => {
    expect(statusDoBelle(belle)).toBe(crm);
  });

  it("status desconhecido vira Agendado, nunca some", () => {
    expect(statusDoBelle("Algo Novo")).toBe("pending");
  });
});

describe("⭐ resposta da paciente × status do Belle", () => {
  it("a paciente confirmou pelo WhatsApp e o Belle ainda diz Marcado: vale a resposta", () => {
    expect(statusFinal("pending", { status: "confirmed", client_responded_at: "2026-10-29T10:00:00Z" })).toBe("confirmed");
    expect(statusFinal("pending", { status: "declined", client_responded_at: "2026-10-29T10:00:00Z" })).toBe("declined");
  });

  it("a recepção mudou o status no Belle: o Belle vence", () => {
    expect(statusFinal("cancelled", { status: "confirmed", client_responded_at: "2026-10-29T10:00:00Z" })).toBe("cancelled");
    expect(statusFinal("completed", { status: "declined", client_responded_at: "2026-10-29T10:00:00Z" })).toBe("completed");
  });

  it("status mudado pela equipe no CRM (sem resposta da paciente) não segura o do Belle", () => {
    expect(statusFinal("pending", { status: "confirmed", client_responded_at: null })).toBe("pending");
  });
});

describe("celular do Belle", () => {
  it("formatos reais do cadastro → E.164", () => {
    expect(telefoneDoBelle("(81)98756-1002", "84")).toBe("+5581987561002");
    expect(telefoneDoBelle("(84)3333-4444", "84")).toBe("+558433334444");
    expect(telefoneDoBelle("8198756100", null)).toBe("+558198756100");
  });

  it("sem DDD usa o DDD da unidade; sem DDD da unidade, não chuta", () => {
    expect(telefoneDoBelle("987561002", "84")).toBe("+5584987561002");
    expect(telefoneDoBelle("987561002", null)).toBeNull();
  });

  it("lixo não vira telefone", () => {
    expect(telefoneDoBelle("123", "84")).toBeNull();
    expect(telefoneDoBelle("4499999999999999", "84")).toBeNull();
    expect(telefoneDoBelle("", "84")).toBeNull();
  });

  it("⭐ as duas grafias do celular — com e sem o nono dígito", () => {
    expect(variantesDoTelefone("+5581987561002")).toEqual(["+5581987561002", "+558187561002"]);
    expect(variantesDoTelefone("+558187561002")).toEqual(["+558187561002", "+5581987561002"]);
    // fixo não ganha nono dígito
    expect(variantesDoTelefone("+558433334444")).toEqual(["+558433334444"]);
  });

  it("DDD da unidade a partir do telefone do estabelecimento", () => {
    expect(dddDoTelefone("(84)3208-1234")).toBe("84");
    expect(dddDoTelefone("")).toBeNull();
  });
});

describe("⭐ junção relatório + lista", () => {
  it("horário EXATO do Belle e duração do relatório (10:00–10:35, o caso do print)", () => {
    const [a] = juntarAgendamentos([linha()], [lista()], TZ);
    expect(a!.startsAt).toBe("2026-10-29T13:00:00.000Z"); // 10:00 em Brasília
    expect(a!.endsAt).toBe("2026-10-29T13:35:00.000Z");
    expect(a!.status).toBe("completed");
    expect(a!.statusExterno).toBe("Atendido");
  });

  it("celular, sala e serviços vêm da lista; serviços com espaços sobrando saem limpos", () => {
    const [a] = juntarAgendamentos([linha()], [lista()], TZ);
    expect(a!.cliente.celular).toBe("(81)98756-1002");
    expect(a!.salaCodigo).toBe("24142");
    expect(a!.titulo).toBe("F. Glúteos Médios, F. Virilha Completa ou Cavada");
    expect(a!.notas).toBe("COM ROSI");
  });

  it("sem lista (só no relatório): entra com o nome da sala e o serviço do relatório", () => {
    const [a] = juntarAgendamentos([linha({ statusAgendamento: "Desmarcado" })], [], TZ);
    expect(a!.salaCodigo).toBeNull();
    expect(a!.salaNome).toBe("Laser 01");
    expect(a!.titulo).toBe("F. Glúteos Médios");
    expect(a!.status).toBe("cancelled");
    expect(a!.cliente.celular).toBe("");
  });

  it("só na lista (marcado entre as duas leituras): entra com a duração padrão", () => {
    const [a] = juntarAgendamentos([], [lista({ codConsulta: "999", status: "Marcado" })], TZ);
    expect(a!.externalId).toBe("999");
    expect(new Date(a!.endsAt).getTime() - new Date(a!.startsAt).getTime()).toBe(30 * 60_000);
  });

  it("avaliação sem serviço vira o tipo do agendamento", () => {
    const [a] = juntarAgendamentos(
      [linha({ nomeServico: "", tipoAgendamento: "Avaliação" })],
      [lista({ servicos: [{ cod: "", nome: "" }] })],
      TZ,
    );
    expect(a!.titulo).toBe("Avaliação");
  });

  it("código repetido no relatório não duplica", () => {
    expect(juntarAgendamentos([linha(), linha()], [lista()], TZ)).toHaveLength(1);
  });

  it("data ou hora fora do formato é ignorada, não vira compromisso em 1970", () => {
    expect(juntarAgendamentos([linha({ dataAgendamento: "2026-10-29" })], [], TZ)).toHaveLength(0);
  });
});

describe("nome de sala", () => {
  it("espaços e acentos não separam a mesma sala", () => {
    expect(chaveDoNome(" Avaliação ")).toBe(chaveDoNome("avaliacao"));
    expect(chaveDoNome("Estético 03 - Criofrequência ")).toBe("estetico 03 - criofrequencia");
  });
});

describe("⭐ tipo de serviço (decide o modelo da confirmação)", () => {
  const catalogo = catalogoPorCodigo([
    { codServico: "33452277", nome: "F. Glúteos Médios", tipo: "4359 - Depilação" },
    { codServico: "55530347", nome: "Criolipólise", tipo: "4360 - Estética" },
  ]);

  it("tipo do catálogo: código estável + nome", () => {
    expect(tipoDoCatalogo("4359 - Depilação")).toEqual({ chave: "tipo:4359", rotulo: "Depilação" });
    expect(tipoDoCatalogo("")).toBeNull();
  });

  it("o agendamento segue o PRIMEIRO serviço conhecido (uma mensagem só)", () => {
    expect(tipoDoAgendamento([" 55530347", "33452277"], "Serviço", catalogo)?.rotulo).toBe("Estética");
    expect(tipoDoAgendamento(["999", "33452277"], "Serviço", catalogo)?.rotulo).toBe("Depilação");
  });

  it("sem serviço (avaliação) vale o tipo do agendamento", () => {
    expect(tipoDoAgendamento([""], "Avaliação", catalogo)).toEqual({ chave: "agendamento:avaliacao", rotulo: "Avaliação" });
  });

  it("a junção já entrega o tipo de cada agendamento — inclusive só pelo relatório", () => {
    const [a] = juntarAgendamentos([linha()], [lista()], TZ, catalogo);
    expect(a!.tipo?.chave).toBe("tipo:4359");
    const [b] = juntarAgendamentos([linha({ codigoServico: "55530347" })], [], TZ, catalogo);
    expect(b!.tipo?.rotulo).toBe("Estética");
  });

  it("sugestão pelo nome: só quando há UM candidato claro", () => {
    const servicos = [
      { id: "a", name: "Avaliação", is_active: true },
      { id: "d", name: "Depilação a Laser", is_active: true },
      { id: "e", name: "Estética Corporal", is_active: true },
      { id: "x", name: "Estética Facial", is_active: true },
      { id: "z", name: "Depilação antiga", is_active: false },
    ];
    expect(sugerirServico("Avaliação", servicos)).toBe("a");
    expect(sugerirServico("Depilação", servicos)).toBe("d");
    expect(sugerirServico("Estética", servicos)).toBeNull(); // duas estéticas: quem configura escolhe
    expect(sugerirServico("Massagem", servicos)).toBeNull();
  });
});
