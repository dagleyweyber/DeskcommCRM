import { describe, expect, it } from "vitest";
import { agregarPorNivel } from "./AnuncioPerformanceTable";
import type { ReceitaPorAnuncio } from "@/hooks/metrics/useSalesDashboard";

/**
 * Meta Ads Fase E4 — reagrupa a MESMA lista (uma linha por anúncio) por
 * campanha/conjunto/anúncio no client, sem consulta nova. O risco real é
 * dois anúncios da MESMA campanha virarem duas linhas em vez de somar.
 */
function linha(overrides: Partial<ReceitaPorAnuncio>): ReceitaPorAnuncio {
  return {
    anuncio: "Anúncio",
    ad_id: "ad-1",
    campaign_id: null,
    campaign_name: null,
    adset_id: null,
    adset_name: null,
    leads: 0,
    vendas: 0,
    agendamentos: 0,
    receita_cents: 0,
    ...overrides,
  };
}

describe("agregarPorNivel", () => {
  const DUAS_CAMPANHAS = [
    linha({
      ad_id: "ad-1",
      anuncio: "Anúncio 1",
      campaign_id: "cg-a",
      campaign_name: "Campanha A",
      adset_id: "cj-1",
      adset_name: "Conjunto 1",
      leads: 3,
      vendas: 1,
      agendamentos: 2,
      receita_cents: 10_000,
    }),
    linha({
      ad_id: "ad-2",
      anuncio: "Anúncio 2",
      campaign_id: "cg-a",
      campaign_name: "Campanha A",
      adset_id: "cj-1",
      adset_name: "Conjunto 1",
      leads: 2,
      vendas: 1,
      agendamentos: 1,
      receita_cents: 5_000,
    }),
    linha({
      ad_id: "ad-3",
      anuncio: "Anúncio 3",
      campaign_id: "cg-b",
      campaign_name: "Campanha B",
      adset_id: "cj-2",
      adset_name: "Conjunto 2",
      leads: 1,
      vendas: 1,
      agendamentos: 0,
      receita_cents: 20_000,
    }),
  ];

  it("⭐ nível 'anuncio': uma linha por ad_id, sem somar nada (grão já é esse)", () => {
    const out = agregarPorNivel(DUAS_CAMPANHAS, "anuncio");
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.chave)).toEqual(["ad-3", "ad-1", "ad-2"]); // ordenado por receita desc
  });

  it("⭐ nível 'campanha': dois anúncios da MESMA campanha somam, não duplicam linha", () => {
    const out = agregarPorNivel(DUAS_CAMPANHAS, "campanha");
    expect(out).toEqual([
      { chave: "cg-b", nome: "Campanha B", leads: 1, vendas: 1, agendamentos: 0, receita_cents: 20_000 },
      { chave: "cg-a", nome: "Campanha A", leads: 5, vendas: 2, agendamentos: 3, receita_cents: 15_000 },
    ]);
  });

  it("⭐ nível 'conjunto': soma pelo adset_id", () => {
    const out = agregarPorNivel(DUAS_CAMPANHAS, "conjunto");
    expect(out.find((l) => l.chave === "cj-1")).toEqual({
      chave: "cj-1",
      nome: "Conjunto 1",
      leads: 5,
      vendas: 2,
      agendamentos: 3,
      receita_cents: 15_000,
    });
  });

  it("anúncio sem campanha/conjunto resolvido cai em 'Sem campanha'/'Sem conjunto', não some", () => {
    const semHierarquia = [linha({ ad_id: "ad-9", anuncio: "Órfão", receita_cents: 1_000 })];
    const porCampanha = agregarPorNivel(semHierarquia, "campanha");
    expect(porCampanha).toEqual([
      { chave: "sem-campanha", nome: "Sem campanha", leads: 0, vendas: 0, agendamentos: 0, receita_cents: 1_000 },
    ]);
    const porConjunto = agregarPorNivel(semHierarquia, "conjunto");
    expect(porConjunto[0]!.nome).toBe("Sem conjunto");
  });

  it("lista vazia devolve lista vazia, não quebra", () => {
    expect(agregarPorNivel([], "campanha")).toEqual([]);
  });
});
