import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Por qual número vai sair?" — organização com mais de um número oficial.
 *
 * O defeito: o formulário usava, calado, o número mais antigo. Com dois números, toda
 * campanha saía por ele e a lista de modelos era a dele. Estes casos travam o contrário: com
 * vários números NINGUÉM é escolhido por padrão, trocar de número avisa o pai (que zera
 * modelo e variáveis), e a saúde do número aparece ANTES de criar.
 */

const numerosMock = vi.fn();
vi.mock("@/hooks/campaigns/useCampaigns", () => ({
  useNumerosDaApi: () => numerosMock(),
}));

import { SeletorDeNumero, useNumeroEscolhido } from "@/app/app/campaigns/_components/SeletorDeNumero";

const numero = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  nome: `Loja ${id}`,
  telefone: null,
  conectado: true,
  qualidade: "GREEN",
  limite: "TIER_1K",
  ultimo_evento: null,
  atualizado_em: null,
  campanhas_andando: 0,
  ...extra,
});

function comNumeros(lista: unknown[]) {
  numerosMock.mockReturnValue({ data: { data: { numeros: lista } }, isPending: false });
}

/** O formulário em miniatura: chama o hook uma vez e reparte, como o formulário de campanha. */
function Mini({ onTrocou }: { onTrocou: (id: string | null) => void }) {
  const [valor, setValor] = useState<string | null>(null);
  const estado = useNumeroEscolhido(valor, (id) => {
    setValor(id);
    onTrocou(id);
  });
  return (
    <>
      <SeletorDeNumero
        estado={estado}
        valor={valor}
        onChange={(id) => {
          setValor(id);
          onTrocou(id);
        }}
      />
      <span data-testid="bloqueado">{String(estado.bloqueado)}</span>
      <span data-testid="valor">{valor ?? "nenhum"}</span>
    </>
  );
}

beforeEach(() => numerosMock.mockReset());

describe("seletor de número", () => {
  it("⭐ com UM número, ele já é o escolhido e nada é perguntado", () => {
    comNumeros([numero("a")]);
    const trocou = vi.fn();
    render(<Mini onTrocou={trocou} />);
    expect(screen.getByTestId("seletor-de-numero-unico").textContent).toContain("Loja a");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("valor").textContent).toBe("a");
    expect(trocou).toHaveBeenCalledWith("a");
  });

  it("⭐ com DOIS números, ninguém é escolhido por padrão — o operador decide", () => {
    comNumeros([numero("a"), numero("b")]);
    render(<Mini onTrocou={vi.fn()} />);
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByTestId("valor").textContent).toBe("nenhum");
  });

  it("cada opção mostra a saúde do número (nota e limite diário)", () => {
    comNumeros([
      numero("a", { qualidade: "YELLOW", limite: "TIER_250" }),
      numero("b", { qualidade: "GREEN", limite: "TIER_1K" }),
    ]);
    render(<Mini onTrocou={vi.fn()} />);
    const opcoes = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opcoes).toContain("Loja a — qualidade média · até 250 contatos por dia");
    expect(opcoes).toContain("Loja b — qualidade alta · até 1.000 contatos por dia");
  });

  it("⭐ trocar de número avisa o pai (que zera modelo e variáveis)", () => {
    comNumeros([numero("a"), numero("b")]);
    const trocou = vi.fn();
    render(<Mini onTrocou={trocou} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(trocou).toHaveBeenLastCalledWith("b");
    expect(screen.getByTestId("valor").textContent).toBe("b");
  });

  it("⭐ número com qualidade BAIXA avisa antes de criar, mas deixa criar", () => {
    comNumeros([numero("a", { qualidade: "RED" }), numero("b")]);
    render(<Mini onTrocou={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
    const aviso = screen.getByTestId("seletor-de-numero-aviso");
    expect(aviso.getAttribute("data-nivel")).toBe("risco");
    expect(aviso.textContent).toContain("BAIXA");
    expect(screen.getByTestId("bloqueado").textContent).toBe("false");
  });

  it("⭐ número desconectado BLOQUEIA a criação", () => {
    comNumeros([numero("a", { conectado: false }), numero("b")]);
    render(<Mini onTrocou={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
    expect(screen.getByTestId("seletor-de-numero-aviso").getAttribute("data-nivel")).toBe("bloqueio");
    expect(screen.getByTestId("bloqueado").textContent).toBe("true");
  });

  it("sem nenhum número oficial, não aparece", () => {
    comNumeros([]);
    render(<Mini onTrocou={vi.fn()} />);
    expect(screen.queryByTestId("seletor-de-numero")).toBeNull();
  });
});
