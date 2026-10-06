import { describe, expect, it } from "vitest";

import { classificaClinica, type SinaisDaClinica } from "./saude-das-clinicas";
import {
  decideIncidentes,
  TIPOS_DE_INCIDENTE,
  type IncidenteAberto,
} from "./vigia-da-saude";

const AGORA = new Date("2026-10-06T12:00:00.000Z");
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";

function sinais(over: Partial<SinaisDaClinica> = {}): SinaisDaClinica {
  return {
    organization_id: ORG_A,
    display_name: "Clínica A",
    slug: "clinica-a",
    status: "active",
    suspended_at: null,
    canais_total: 1,
    canais_working: 1,
    agentes_publicados: 1,
    credenciais_ia_ativas: 1,
    mensagens_falhas_24h: 0,
    fila_pendente_desde: null,
    eventos_mortos_7d: 0,
    avisos_abertos: 0,
    ultima_mensagem_at: null,
    ...over,
  };
}

const clinica = (over?: Partial<SinaisDaClinica>) => classificaClinica(sinais(over), AGORA);

describe("decideIncidentes", () => {
  it("clínica saudável não abre nada", () => {
    expect(decideIncidentes([clinica()], [])).toEqual({ abrir: [], resolver: [] });
  });

  it("⭐ canal fora do ar abre incidente crítico com o nome da clínica no payload", () => {
    const d = decideIncidentes([clinica({ canais_total: 2, canais_working: 0 })], []);

    expect(d.abrir).toHaveLength(1);
    expect(d.abrir[0]!.type).toBe(TIPOS_DE_INCIDENTE.canal);
    expect(d.abrir[0]!.severity).toBe("critical");
    expect(d.abrir[0]!.organization_id).toBe(ORG_A);
    // Quem lê o incidente precisa saber de QUEM é sem abrir outra tela.
    expect(d.abrir[0]!.payload).toMatchObject({ clinica: "Clínica A", detalhe: "0 de 2 no ar" });
  });

  it("⭐ IA publicada sem credencial abre incidente próprio (o incidente real)", () => {
    const d = decideIncidentes([clinica({ agentes_publicados: 1, credenciais_ia_ativas: 0 })], []);

    expect(d.abrir.map((i) => i.type)).toEqual([TIPOS_DE_INCIDENTE.ia]);
  });

  it("⭐ DEDUP: não reabre o que já está aberto", () => {
    const abertos: IncidenteAberto[] = [
      { id: "inc-1", organization_id: ORG_A, type: TIPOS_DE_INCIDENTE.canal },
    ];

    const d = decideIncidentes([clinica({ canais_total: 1, canais_working: 0 })], abertos);

    expect(d.abrir).toEqual([]);
    expect(d.resolver).toEqual([]); // segue crítico: mantém aberto
  });

  it("incidente 'acknowledged' também conta como aberto (não duplica)", () => {
    // O vigia lê open E acknowledged; alguém ter reconhecido não é motivo para
    // abrir um segundo igual.
    const abertos: IncidenteAberto[] = [
      { id: "inc-ack", organization_id: ORG_A, type: TIPOS_DE_INCIDENTE.ia },
    ];

    const d = decideIncidentes([clinica({ credenciais_ia_ativas: 0 })], abertos);

    expect(d.abrir).toEqual([]);
  });

  it("⭐ RECUPERAÇÃO: sinal voltou ao normal resolve o incidente aberto", () => {
    const abertos: IncidenteAberto[] = [
      { id: "inc-1", organization_id: ORG_A, type: TIPOS_DE_INCIDENTE.canal },
    ];

    const d = decideIncidentes([clinica()], abertos); // clínica saudável agora

    expect(d.resolver).toEqual(["inc-1"]);
    expect(d.abrir).toEqual([]);
  });

  it("clínica que sumiu do retrato também resolve (não deixa entulho órfão)", () => {
    const abertos: IncidenteAberto[] = [
      { id: "inc-sumiu", organization_id: ORG_B, type: TIPOS_DE_INCIDENTE.fila },
    ];

    const d = decideIncidentes([clinica()], abertos);

    expect(d.resolver).toEqual(["inc-sumiu"]);
  });

  it("⭐ clínica SUSPENSA não abre incidente, mesmo quebrada", () => {
    const d = decideIncidentes(
      [
        clinica({
          suspended_at: "2026-09-01T00:00:00.000Z",
          status: "suspended",
          canais_working: 0,
          credenciais_ia_ativas: 0,
        }),
      ],
      [],
    );

    expect(d.abrir).toEqual([]);
  });

  it("⭐ 'atenção' NÃO vira incidente — alerta que grita com o tolerável é ignorado", () => {
    // 1 falha em 24h e canal parcial são atenção no painel, não alarme.
    const d = decideIncidentes(
      [clinica({ mensagens_falhas_24h: 1, canais_total: 2, canais_working: 1 })],
      [],
    );

    expect(d.abrir).toEqual([]);
  });

  it("nunca mexe em incidente de outra origem (tipo não governado)", () => {
    const abertos: IncidenteAberto[] = [
      { id: "inc-alheio", organization_id: ORG_A, type: "deploy.falhou" },
    ];

    const d = decideIncidentes([clinica()], abertos);

    expect(d.resolver).toEqual([]);
  });

  it("incidente sem organização (plataforma) é ignorado por este vigia", () => {
    const abertos: IncidenteAberto[] = [
      { id: "inc-plataforma", organization_id: null, type: TIPOS_DE_INCIDENTE.canal },
    ];

    const d = decideIncidentes([clinica()], abertos);

    expect(d.resolver).toEqual([]);
  });

  it("várias clínicas e vários sinais na mesma rodada", () => {
    const a = classificaClinica(sinais({ canais_total: 1, canais_working: 0 }), AGORA);
    const b = classificaClinica(
      sinais({
        organization_id: ORG_B,
        display_name: "Clínica B",
        credenciais_ia_ativas: 0,
        mensagens_falhas_24h: 30,
      }),
      AGORA,
    );

    const d = decideIncidentes([a, b], []);

    expect(d.abrir).toHaveLength(3);
    expect(d.abrir.filter((i) => i.organization_id === ORG_A).map((i) => i.type)).toEqual([
      TIPOS_DE_INCIDENTE.canal,
    ]);
    expect(
      d.abrir.filter((i) => i.organization_id === ORG_B).map((i) => i.type).sort(),
    ).toEqual([TIPOS_DE_INCIDENTE.ia, TIPOS_DE_INCIDENTE.mensagens].sort());
  });
});
