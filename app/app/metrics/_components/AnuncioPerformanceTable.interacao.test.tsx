import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnuncioPerformanceTable } from "./AnuncioPerformanceTable";
import type { ReceitaPorAnuncio } from "@/hooks/metrics/useSalesDashboard";

/**
 * Meta Ads — drill-down tipo Gerenciador de Anúncios: selecionar uma
 * campanha escopa "Conjunto de anúncios"/"Anúncio" só aos dados dela;
 * selecionar um conjunto escopa "Anúncio" só a ele. Achado ao vivo (pedido
 * do usuário comparando com o Gerenciador de Anúncios real): antes disto as
 * 3 abas eram independentes — cada uma reagrupava a MESMA lista inteira,
 * sem nenhuma relação entre a campanha/conjunto escolhido numa aba e o que
 * aparecia nas outras.
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

const DADOS: ReceitaPorAnuncio[] = [
  linha({
    ad_id: "ad-1",
    anuncio: "Anúncio 1",
    campaign_id: "cg-a",
    campaign_name: "Campanha A",
    adset_id: "cj-1",
    adset_name: "Conjunto 1",
    leads: 3,
    receita_cents: 10_000,
  }),
  linha({
    ad_id: "ad-2",
    anuncio: "Anúncio 2",
    campaign_id: "cg-a",
    campaign_name: "Campanha A",
    adset_id: "cj-2",
    adset_name: "Conjunto 2",
    leads: 2,
    receita_cents: 5_000,
  }),
  linha({
    ad_id: "ad-3",
    anuncio: "Anúncio 3",
    campaign_id: "cg-b",
    campaign_name: "Campanha B",
    adset_id: "cj-3",
    adset_name: "Conjunto 3",
    leads: 1,
    receita_cents: 20_000,
  }),
];

async function irParaAba(nome: string) {
  await userEvent.click(screen.getByRole("tab", { name: nome }));
}

function linhasDaTabela() {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1); // pula o header
}

describe("AnuncioPerformanceTable — drill-down campanha → conjunto → anúncio", () => {
  it("⭐ selecionar Campanha A na aba Campanha escopa a aba Conjunto só aos conjuntos dela", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));

    await irParaAba("Conjunto de anúncios");
    expect(screen.getByText("Conjunto 1")).toBeInTheDocument();
    expect(screen.getByText("Conjunto 2")).toBeInTheDocument();
    expect(screen.queryByText("Conjunto 3")).not.toBeInTheDocument();
    expect(screen.getByText("Campanha A")).toBeInTheDocument(); // badge do filtro ativo
  });

  it("⭐ selecionar Campanha A depois Conjunto 1 escopa a aba Anúncio só aos anúncios do Conjunto 1", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));
    await irParaAba("Conjunto de anúncios");
    await userEvent.click(screen.getByText("Conjunto 1"));

    await irParaAba("Anúncio");
    expect(screen.getByText("Anúncio 1")).toBeInTheDocument();
    expect(screen.queryByText("Anúncio 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Anúncio 3")).not.toBeInTheDocument();
  });

  it("trocar a campanha selecionada limpa o conjunto (ele era do contexto antigo)", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));
    await irParaAba("Conjunto de anúncios");
    await userEvent.click(screen.getByText("Conjunto 1"));

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha B"));

    await irParaAba("Anúncio");
    expect(screen.getByText("Anúncio 3")).toBeInTheDocument();
    expect(screen.queryByText("Anúncio 1")).not.toBeInTheDocument();
  });

  it("clicar 'Limpar' no filtro ativo volta a aba a mostrar tudo", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));
    await irParaAba("Conjunto de anúncios");
    expect(screen.queryByText("Conjunto 3")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Limpar" }));
    expect(screen.getByText("Conjunto 3")).toBeInTheDocument();
  });

  it("clicar de novo na mesma campanha desmarca a seleção", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));
    await userEvent.click(screen.getByText("Campanha A"));

    await irParaAba("Conjunto de anúncios");
    expect(screen.getByText("Conjunto 3")).toBeInTheDocument();
  });

  it("aba Campanha nunca é filtrada por seleção própria — sempre mostra as duas campanhas", async () => {
    render(<AnuncioPerformanceTable dados={DADOS} />);

    await irParaAba("Campanha");
    await userEvent.click(screen.getByText("Campanha A"));

    expect(screen.getByText("Campanha A")).toBeInTheDocument();
    expect(screen.getByText("Campanha B")).toBeInTheDocument();
    expect(linhasDaTabela()).toHaveLength(2);
  });
});
