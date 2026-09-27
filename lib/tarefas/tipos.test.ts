/**
 * A REGRA DE PRAZO DA TAREFA, com o relógio FIXO.
 *
 * Duas coisas medidas aqui:
 *
 *   1. A faixa não pode decidir com `new Date()` lido lá dentro — um caso de
 *      "vence hoje às 23h" ficaria verde de manhã e vermelho à noite, e um
 *      teste que muda de resposta com a hora da rodada não vigia nada. Por
 *      isso `agora` é parâmetro em toda função.
 *   2. `diaLocalDoPrazo` não pode ler o dia em UTC (`due_date.slice(0,10)`) —
 *      o caso de 31/12 às 21h em Brasília está no segundo describe.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agrupaPorPrazo,
  diaLocalDoPrazo,
  estaAtrasada,
  estaEncerrada,
  faixaDePrazo,
  type Tarefa,
} from "./tipos";

/** Quarta-feira, 2026-09-02, 10:00 local. */
const AGORA = new Date(2026, 8, 2, 10, 0, 0);

function tarefa(p: Partial<Tarefa>): Tarefa {
  return {
    id: "t",
    organization_id: "o",
    title: "t",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: null,
    contact_id: null,
    assigned_to: null,
    created_by: null,
    created_at: AGORA.toISOString(),
    updated_at: AGORA.toISOString(),
    ...p,
  };
}

/** ISO com o offset LOCAL da máquina — é assim que o navegador manda o prazo. */
function local(ano: number, mes: number, dia: number, hora = 9, min = 0): string {
  return new Date(ano, mes - 1, dia, hora, min, 0).toISOString();
}

describe("estaEncerrada", () => {
  it("done e cancelled são encerradas; pending e in_progress não", () => {
    expect(estaEncerrada(tarefa({ status: "done" }))).toBe(true);
    expect(estaEncerrada(tarefa({ status: "cancelled" }))).toBe(true);
    expect(estaEncerrada(tarefa({ status: "pending" }))).toBe(false);
    expect(estaEncerrada(tarefa({ status: "in_progress" }))).toBe(false);
  });
});

describe("prazo da tarefa", () => {
  it("sem prazo nunca está atrasada — a coluna é nullable de propósito", () => {
    expect(estaAtrasada(tarefa({ due_date: null }), AGORA)).toBe(false);
    expect(faixaDePrazo(tarefa({ due_date: null }), AGORA)).toBe("sem_prazo");
  });

  it("prazo vencido e ainda aberta está atrasada", () => {
    expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 1) }), AGORA)).toBe(true);
  });

  it("encerrada não atrasa, mesmo com o prazo vencido", () => {
    for (const status of ["done", "cancelled"] as const) {
      expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 1), status }), AGORA)).toBe(false);
      expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 1), status }), AGORA)).toBe(
        "encerrada",
      );
    }
  });

  it("hoje mais cedo AINDA é hoje, não 'atrasada' — a faixa é do DIA", () => {
    expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 2, 8) }), AGORA)).toBe(true);
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 2, 8) }), AGORA)).toBe("hoje");
  });

  it("as faixas cobrem a semana e o depois", () => {
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 4) }), AGORA)).toBe("esta_semana");
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 8) }), AGORA)).toBe("esta_semana");
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 30) }), AGORA)).toBe("mais_tarde");
  });

  it("o agrupamento sai na ordem da tela e não devolve grupo vazio", () => {
    const grupos = agrupaPorPrazo(
      [
        tarefa({ id: "a", due_date: local(2026, 9, 30) }),
        tarefa({ id: "b", due_date: local(2026, 9, 1) }),
        tarefa({ id: "c", due_date: local(2026, 9, 2, 15) }),
      ],
      AGORA,
    );
    expect(grupos.map((g) => g.faixa)).toEqual(["atrasada", "hoje", "mais_tarde"]);
    expect(grupos.flatMap((g) => g.tarefas.map((t) => t.id))).toEqual(["b", "c", "a"]);
  });

  it("lista vazia devolve grupos vazios", () => {
    expect(agrupaPorPrazo([], AGORA)).toEqual([]);
  });
});

describe("o dia do calendário é o dia de QUEM OLHA", () => {
  /**
   * ⚠️ O FUSO É FIXADO AQUI, e sem isto o caso abaixo não mede nada.
   *
   * O CI roda em UTC. Em UTC, `2026-12-31T21:00` local É `2026-12-31T21:00Z`, o
   * recorte do ISO acerta por coincidência, e o teste ficaria verde sobre o
   * defeito que ele existe para prender. Fixar o fuso é o que torna a asserção
   * a mesma na máquina de quem escreve e no runner.
   */
  const fusoOriginal = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Sao_Paulo";
  });
  afterAll(() => {
    if (fusoOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = fusoOriginal;
  });

  it("prazo à noite não pula para o dia seguinte", () => {
    // `2026-12-31T21:00` em Brasília é `2027-01-01T00:00Z`. Com o recorte do
    // ISO em UTC, a tarefa marcada para 31 de dezembro desapareceria do mês de
    // dezembro e reapareceria em janeiro.
    const iso = local(2026, 12, 31, 21);
    expect(diaLocalDoPrazo(iso)).toBe("2026-12-31");
    expect(diaLocalDoPrazo(iso)).not.toBe(iso.slice(0, 10));
  });

  it("prazo de manhã também casa com o próprio dia", () => {
    expect(diaLocalDoPrazo(local(2026, 3, 5, 9))).toBe("2026-03-05");
  });
});
