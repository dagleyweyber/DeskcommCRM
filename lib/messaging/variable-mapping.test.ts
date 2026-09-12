import { describe, expect, it } from "vitest";

import { resolveValuesForRecipient } from "./variable-mapping";

describe("resolveValuesForRecipient", () => {
  it("texto fixo sai igual pra todo mundo", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "fixed", value: "Promoção de setembro" } },
      { displayName: "María González" },
    );
    expect(r).toEqual({ "1": "Promoção de setembro" });
  });

  it("nome do contato usa o rótulo inteiro", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_name" } },
      { displayName: "María González" },
    );
    expect(r["1"]).toBe("María González");
  });

  it("primeiro nome corta no primeiro espaço", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_first_name" } },
      { displayName: "María González" },
    );
    expect(r["1"]).toBe("María");
  });

  it("nome de uma palavra só não quebra o primeiro nome", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "contact_first_name" } },
      { displayName: "María" },
    );
    expect(r["1"]).toBe("María");
  });

  it("vários slots resolvem independentes, cada um com sua fonte", () => {
    const r = resolveValuesForRecipient(
      {
        "1": { kind: "contact_first_name" },
        "header:1": { kind: "fixed", value: "Bem-vindo" },
        "button0:1": { kind: "contact_name" },
      },
      { displayName: "Ana Paula Silva" },
    );
    expect(r).toEqual({
      "1": "Ana",
      "header:1": "Bem-vindo",
      "button0:1": "Ana Paula Silva",
    });
  });

  it("mapeamento vazio devolve objeto vazio, não erro", () => {
    expect(resolveValuesForRecipient({}, { displayName: "Qualquer" })).toEqual({});
  });
});

describe("resolveValuesForRecipient — appointment_date/appointment_time (automações)", () => {
  // Achado ao vivo: diferente de Campanhas (lista fechada, resolvida uma
  // vez na criação), a automação de lembrete de agendamento não tem
  // destinatário fixo — o horário só existe quando a ocorrência é
  // encontrada, então estes dois `kind` são resolvidos na hora do envio,
  // não pré-calculados.
  const ISO_MANHA = "2026-09-15T11:30:00.000Z"; // 08:30 em América/São_Paulo (UTC-3)

  it("⭐ appointment_date formata dia/mês em pt-BR, fuso América/São_Paulo", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "appointment_date" } },
      { displayName: "Paciente Teste", appointmentAt: ISO_MANHA },
    );
    expect(r["1"]).toBe("15/09");
  });

  it("⭐ appointment_time formata HH:mm em pt-BR, fuso América/São_Paulo", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "appointment_time" } },
      { displayName: "Paciente Teste", appointmentAt: ISO_MANHA },
    );
    expect(r["1"]).toBe("08:30");
  });

  it("sem appointmentAt (mapeamento usado fora do gatilho certo), devolve vazio — não quebra", () => {
    const r = resolveValuesForRecipient(
      { "1": { kind: "appointment_date" }, "2": { kind: "appointment_time" } },
      { displayName: "Sem Agendamento" },
    );
    expect(r).toEqual({ "1": "", "2": "" });
  });
});
