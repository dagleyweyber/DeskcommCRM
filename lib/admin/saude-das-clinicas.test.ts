import { describe, expect, it } from "vitest";

import {
  classificaClinica,
  ordenaPorGravidade,
  pior,
  type SinaisDaClinica,
} from "./saude-das-clinicas";

const AGORA = new Date("2026-10-06T12:00:00.000Z");

/** Clínica saudável — cada teste piora UM sinal, para isolar a régua. */
function clinicaOk(over: Partial<SinaisDaClinica> = {}): SinaisDaClinica {
  return {
    organization_id: "11111111-1111-4111-8111-111111111111",
    display_name: "Clínica Teste",
    slug: "clinica-teste",
    status: "active",
    suspended_at: null,
    // Padrão = onboarding concluído: é o caso comum testado na maioria dos
    // cenários (clínica operando). Testes do estado "ainda configurando"
    // sobrescrevem para null explicitamente.
    onboarded_at: "2026-09-01T00:00:00.000Z",
    canais_total: 1,
    canais_working: 1,
    agentes_publicados: 1,
    credenciais_ia_ativas: 1,
    mensagens_falhas_24h: 0,
    fila_pendente_desde: null,
    eventos_mortos_7d: 0,
    avisos_abertos: 0,
    ultima_mensagem_at: "2026-10-06T11:55:00.000Z",
    ...over,
  };
}

describe("classificaClinica", () => {
  it("clínica inteira saudável sai 'ok' em tudo", () => {
    const r = classificaClinica(clinicaOk(), AGORA);
    expect(r.geral).toBe("ok");
    expect(r.canal.saude).toBe("ok");
    expect(r.ia.saude).toBe("ok");
    expect(r.fila.saude).toBe("ok");
  });

  it("⭐ agente publicado SEM credencial válida é CRÍTICO (o incidente silencioso)", () => {
    // B'Laser Caruaru e RevitaFio Carpina: semanas com a IA muda, sem alarme.
    const r = classificaClinica(
      clinicaOk({ agentes_publicados: 1, credenciais_ia_ativas: 0 }),
      AGORA,
    );
    expect(r.ia.saude).toBe("critico");
    expect(r.ia.detalhe).toMatch(/SEM credencial/i);
    expect(r.geral).toBe("critico");
  });

  it("quem NÃO usa IA não é cobrado por credencial (alarme falso ensina a ignorar)", () => {
    const r = classificaClinica(
      clinicaOk({ agentes_publicados: 0, credenciais_ia_ativas: 0 }),
      AGORA,
    );
    expect(r.ia.saude).toBe("ok");
    expect(r.geral).toBe("ok");
  });

  it("⭐ canal conectado porém nenhum no ar é CRÍTICO (clínica surda e muda)", () => {
    const r = classificaClinica(clinicaOk({ canais_total: 2, canais_working: 0 }), AGORA);
    expect(r.canal.saude).toBe("critico");
    expect(r.canal.detalhe).toBe("0 de 2 no ar");
  });

  it("canal parcialmente no ar é atenção, não crítico", () => {
    const r = classificaClinica(clinicaOk({ canais_total: 2, canais_working: 1 }), AGORA);
    expect(r.canal.saude).toBe("atencao");
  });

  it("nenhum canal cadastrado é atenção ENQUANTO ainda está configurando (onboarding em curso), não crítico", () => {
    const r = classificaClinica(
      clinicaOk({ canais_total: 0, canais_working: 0, onboarded_at: null }),
      AGORA,
    );
    expect(r.canal.saude).toBe("atencao");
    expect(r.canal.detalhe).toMatch(/Nenhum canal/);
  });

  it("⭐ nenhum canal cadastrado é CRÍTICO depois do onboarding concluído (migration 0189 — a cegueira do vigia)", () => {
    // Sem esta distinção, uma clínica podia terminar o cadastro e ficar muda
    // no WhatsApp pra sempre sem o vigia (item 3) jamais abrir incidente — ele
    // só age em crítico, e "zero canal" sempre foi "atenção" até aqui.
    const r = classificaClinica(clinicaOk({ canais_total: 0, canais_working: 0 }), AGORA);
    expect(r.canal.saude).toBe("critico");
    expect(r.canal.detalhe).toMatch(/Onboarding concluído/);
    expect(r.geral).toBe("critico");
  });

  it("⭐ fila parada há dias é crítica e o detalhe diz em DIAS (o backlog de 48 dias)", () => {
    const r = classificaClinica(
      clinicaOk({ fila_pendente_desde: "2026-08-19T12:00:00.000Z" }),
      AGORA,
    );
    expect(r.fila.saude).toBe("critico");
    expect(r.fila.detalhe).toBe("48d parada");
  });

  it("fila com atraso de minutos fica em 'ok' abaixo do limiar e 'atencao' acima", () => {
    const quase = classificaClinica(
      clinicaOk({ fila_pendente_desde: "2026-10-06T11:45:00.000Z" }), // 15min
      AGORA,
    );
    expect(quase.fila.saude).toBe("ok");

    const passou = classificaClinica(
      clinicaOk({ fila_pendente_desde: "2026-10-06T11:20:00.000Z" }), // 40min
      AGORA,
    );
    expect(passou.fila.saude).toBe("atencao");
  });

  it("mensagens falhas: 1 é atenção, 10 é crítico", () => {
    expect(classificaClinica(clinicaOk({ mensagens_falhas_24h: 1 }), AGORA).mensagens.saude).toBe(
      "atencao",
    );
    expect(classificaClinica(clinicaOk({ mensagens_falhas_24h: 10 }), AGORA).mensagens.saude).toBe(
      "critico",
    );
  });

  it("avisos abertos e eventos mortos aparecem juntos no detalhe", () => {
    const r = classificaClinica(
      clinicaOk({ avisos_abertos: 2, eventos_mortos_7d: 3 }),
      AGORA,
    );
    expect(r.avisos.saude).toBe("atencao");
    expect(r.avisos.detalhe).toContain("2 aviso(s)");
    expect(r.avisos.detalhe).toContain("3 evento(s) morto(s)");
  });

  it("⭐ clínica SUSPENSA não dispara alarme, mesmo com tudo quebrado", () => {
    // Canal parado numa conta suspensa é o esperado — alarme aqui é falso.
    const r = classificaClinica(
      clinicaOk({
        suspended_at: "2026-09-01T00:00:00.000Z",
        status: "suspended",
        canais_working: 0,
        credenciais_ia_ativas: 0,
        mensagens_falhas_24h: 50,
      }),
      AGORA,
    );
    expect(r.geral).toBe("suspenso");
  });

  it("o geral é o PIOR sinal, não uma média", () => {
    const r = classificaClinica(
      clinicaOk({ mensagens_falhas_24h: 1, canais_working: 0, canais_total: 1 }),
      AGORA,
    );
    expect(r.mensagens.saude).toBe("atencao");
    expect(r.canal.saude).toBe("critico");
    expect(r.geral).toBe("critico");
  });
});

describe("pior", () => {
  it("escolhe o mais grave e trata lista vazia como ok", () => {
    expect(pior("ok", "atencao", "critico")).toBe("critico");
    expect(pior("ok", "atencao")).toBe("atencao");
    expect(pior("ok", "ok")).toBe("ok");
    expect(pior()).toBe("ok");
  });
});

describe("ordenaPorGravidade", () => {
  it("⭐ quem precisa de socorro aparece no topo, sem precisar filtrar", () => {
    const base = clinicaOk();
    const lista = [
      classificaClinica({ ...base, display_name: "Zeta (ok)" }, AGORA),
      classificaClinica(
        { ...base, display_name: "Alfa (crítica)", canais_total: 1, canais_working: 0 },
        AGORA,
      ),
      classificaClinica({ ...base, display_name: "Beta (atenção)", mensagens_falhas_24h: 2 }, AGORA),
      classificaClinica(
        { ...base, display_name: "Gama (suspensa)", suspended_at: "2026-01-01T00:00:00.000Z" },
        AGORA,
      ),
    ];

    expect(ordenaPorGravidade(lista).map((c) => c.display_name)).toEqual([
      "Alfa (crítica)",
      "Beta (atenção)",
      "Zeta (ok)",
      "Gama (suspensa)",
    ]);
  });

  it("empate de gravidade desempata por nome, e não muta a lista original", () => {
    const base = clinicaOk();
    const original = [
      classificaClinica({ ...base, display_name: "Beta" }, AGORA),
      classificaClinica({ ...base, display_name: "Alfa" }, AGORA),
    ];
    const copia = [...original];

    expect(ordenaPorGravidade(original).map((c) => c.display_name)).toEqual(["Alfa", "Beta"]);
    expect(original).toEqual(copia);
  });
});
