import { describe, expect, it } from "vitest";

import {
  camposAlterados,
  fraseDoConflito,
  momentoValido,
  mudouAlvoOuMomento,
  mudouBotoes,
  type ConfiguracaoDaAutomacao,
} from "./configuracao";

const base: ConfiguracaoDaAutomacao = {
  name: "Lembrete",
  template_name: "lembrete",
  template_language: "pt_BR",
  variable_mapping: { "body.1": { kind: "contact_first_name" } },
  event_type_id: null,
  timing_kind: "day_of_8am",
  timing_value: null,
  confirm_button_text: "Confirmar",
  decline_button_text: "Remarcar",
};

describe("momentoValido", () => {
  it("espelha o CHECK do banco: dias 1–7, horas 1–72, 'no dia' sem número", () => {
    expect(momentoValido("day_of_8am", null)).toBe(true);
    expect(momentoValido("day_of_8am", 1)).toBe(false);
    expect(momentoValido("days_before", 7)).toBe(true);
    expect(momentoValido("days_before", 8)).toBe(false);
    expect(momentoValido("hours_before", 72)).toBe(true);
    expect(momentoValido("hours_before", null)).toBe(false);
  });
});

describe("camposAlterados", () => {
  it("nada mudou = lista vazia", () => {
    expect(camposAlterados(base, { ...base })).toEqual([]);
  });

  it("devolve só os campos que mudaram, comparando o mapeamento por valor", () => {
    const depois = {
      ...base,
      name: "Outro",
      variable_mapping: { "body.1": { kind: "contact_name" as const } },
    };
    expect(camposAlterados(base, depois)).toEqual(["name", "variable_mapping"]);
  });

  it("mapeamento igual em outra instância NÃO conta como mudança", () => {
    expect(camposAlterados(base, { ...base, variable_mapping: { "body.1": { kind: "contact_first_name" } } })).toEqual([]);
  });
});

describe("mudouBotoes", () => {
  it("⭐ ignora caixa, acento e espaço: 'confirmar ' é o mesmo botão que 'Confirmar'", () => {
    expect(mudouBotoes(base, { ...base, confirm_button_text: " confirmar " })).toBe(false);
  });
  it("trocar, tirar ou pôr um botão é mudança", () => {
    expect(mudouBotoes(base, { ...base, confirm_button_text: "Sim" })).toBe(true);
    expect(mudouBotoes(base, { ...base, decline_button_text: null })).toBe(true);
    expect(mudouBotoes({ ...base, confirm_button_text: null, decline_button_text: null }, base)).toBe(true);
  });
});

describe("mudouAlvoOuMomento", () => {
  it("serviço ou momento mudam o alvo da trava; nome e modelo não", () => {
    expect(mudouAlvoOuMomento(base, { ...base, event_type_id: "x" })).toBe(true);
    expect(mudouAlvoOuMomento(base, { ...base, timing_kind: "hours_before", timing_value: 2 })).toBe(true);
    expect(mudouAlvoOuMomento(base, { ...base, name: "x", template_name: "y" })).toBe(false);
  });
});

describe("fraseDoConflito", () => {
  it("diz qual é a outra e o que fazer", () => {
    expect(fraseDoConflito(true, "Corporal")).toMatch(/este serviço.*"Corporal".*Pause-a/);
    expect(fraseDoConflito(false, "Geral")).toMatch(/todos os serviços/);
  });
});
