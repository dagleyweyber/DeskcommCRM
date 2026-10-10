import { describe, expect, it } from "vitest";

import { pendenciasParaConcluir, type SinaisDeProntidao } from "./prontidao";

function pronta(over: Partial<SinaisDeProntidao> = {}): SinaisDeProntidao {
  return { canais_working: 1, agentes_publicados: 1, credenciais_ia_ativas: 1, ...over };
}

describe("pendenciasParaConcluir", () => {
  it("clínica pronta (canal no ar + IA com credencial) não tem pendência", () => {
    expect(pendenciasParaConcluir(pronta())).toEqual([]);
  });

  it("clínica sem IA nenhuma (não publicou agente) também não tem pendência de IA", () => {
    const r = pendenciasParaConcluir(pronta({ agentes_publicados: 0, credenciais_ia_ativas: 0 }));
    expect(r).toEqual([]);
  });

  it("⭐ zero canal funcionando BLOQUEIA — produto de WhatsApp sem WhatsApp não está pronto", () => {
    const r = pendenciasParaConcluir(pronta({ canais_working: 0 }));
    expect(r.map((p) => p.motivo)).toEqual(["sem_canal_funcionando"]);
    expect(r[0]!.mensagem).toMatch(/WhatsApp/);
  });

  it("⭐ agente publicado sem credencial BLOQUEIA — o incidente provado (B'Laser Caruaru / RevitaFio Carpina)", () => {
    const r = pendenciasParaConcluir(pronta({ agentes_publicados: 1, credenciais_ia_ativas: 0 }));
    expect(r.map((p) => p.motivo)).toEqual(["ia_sem_credencial"]);
    expect(r[0]!.mensagem).toMatch(/silêncio/);
  });

  it("as duas pendências aparecem juntas quando as duas coisas estão quebradas", () => {
    const r = pendenciasParaConcluir({
      canais_working: 0,
      agentes_publicados: 1,
      credenciais_ia_ativas: 0,
    });
    expect(r.map((p) => p.motivo).sort()).toEqual(
      ["ia_sem_credencial", "sem_canal_funcionando"].sort(),
    );
  });

  it("vários canais no ar e várias credenciais ativas não bloqueiam (não é teto de 1)", () => {
    const r = pendenciasParaConcluir(
      pronta({ canais_working: 3, agentes_publicados: 2, credenciais_ia_ativas: 2 }),
    );
    expect(r).toEqual([]);
  });
});
