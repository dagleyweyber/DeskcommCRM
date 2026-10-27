import { describe, expect, it } from "vitest";

import {
  diaDaSemana,
  faixaDaGrade,
  janelasAbertas,
  minutosNoDia,
  rotuloDoHorario,
  semanasDoMes,
} from "./grade";
import type { HorarioDeFuncionamento } from "./tipos";

const PADRAO: HorarioDeFuncionamento = {
  timezone: "America/Sao_Paulo",
  windows: [
    { dow: 1, start: "08:00", end: "20:00" },
    { dow: 2, start: "08:00", end: "20:00" },
    { dow: 6, start: "08:00", end: "14:00" },
  ],
};

// 2026-10-26 é segunda-feira; 2026-10-25, domingo.
const SEGUNDA = "2026-10-26";
const DOMINGO = "2026-10-25";

describe("grade da agenda", () => {
  it("diaDaSemana lê a data civil sem depender do fuso do processo", () => {
    expect(diaDaSemana(SEGUNDA)).toBe(1);
    expect(diaDaSemana(DOMINGO)).toBe(0);
  });

  it("minutosNoDia usa o fuso da clínica, não o do navegador", () => {
    // 13:30Z = 10:30 em São Paulo (UTC-03)
    expect(minutosNoDia("2026-10-26T13:30:00Z", "America/Sao_Paulo")).toBe(10 * 60 + 30);
  });

  it("sala sem horário próprio herda o padrão; com horário próprio, usa o dela", () => {
    expect(rotuloDoHorario({ schedule: null }, PADRAO, SEGUNDA)).toBe("08–20h");
    const propria: HorarioDeFuncionamento = { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "13:00", end: "21:00" }] };
    expect(rotuloDoHorario({ schedule: propria }, PADRAO, SEGUNDA)).toBe("13–21h");
    expect(rotuloDoHorario({ schedule: null }, PADRAO, DOMINGO)).toBe("Fechada");
  });

  it("bloqueio da clínica inteira e da própria sala recortam a janela; o de outra sala não", () => {
    const janelas = janelasAbertas({ id: "s1", schedule: null }, PADRAO, SEGUNDA, [
      { room_id: null, start_time: "12:00", end_time: "13:00" },
      { room_id: "s1", start_time: "18:00", end_time: "20:00" },
      { room_id: "s2", start_time: "08:00", end_time: "20:00" },
    ]);
    expect(janelas).toEqual([
      { inicio: 8 * 60, fim: 12 * 60 },
      { inicio: 13 * 60, fim: 18 * 60 },
    ]);
  });

  it("bloqueio de dia inteiro fecha a sala", () => {
    expect(janelasAbertas({ id: "s1", schedule: null }, PADRAO, SEGUNDA, [{ room_id: null, start_time: null, end_time: null }])).toEqual([]);
  });

  it("faixa da grade cobre o horário das salas e alarga para compromisso fora dele", () => {
    expect(faixaDaGrade([{ schedule: null }], PADRAO, SEGUNDA, [])).toEqual({ inicio: 8 * 60, fim: 20 * 60 });
    expect(faixaDaGrade([{ schedule: null }], PADRAO, SEGUNDA, [{ inicio: 20 * 60, fim: 21 * 60 + 15 }])).toEqual({
      inicio: 8 * 60,
      fim: 22 * 60,
    });
    expect(faixaDaGrade([{ schedule: null }], PADRAO, DOMINGO, [])).toEqual({ inicio: 8 * 60, fim: 18 * 60 });
  });

  it("mini-calendário: 42 dias começando no domingo da semana do dia 1", () => {
    const dias = semanasDoMes(2026, 9); // outubro/2026 — dia 1 é quinta
    expect(dias).toHaveLength(42);
    expect(dias[0]).toBe("2026-09-27");
    expect(dias[4]).toBe("2026-10-01");
  });
});
