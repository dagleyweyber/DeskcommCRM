/**
 * Barra de rolagem horizontal do Kanban presa ao pé da janela.
 *
 * O quadro cresce com a coluna mais longa e a página rola na vertical; a barra
 * nativa ficava no fim do quadro, abaixo da dobra. A barra espelho fica `fixed`
 * no pé da janela e rola junto com o quadro, nos dois sentidos.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { geometriaDaBarra, useBarraDeRolagemFixa } from "@/hooks/kanban/useBarraDeRolagemFixa";

afterEach(cleanup);

describe("geometriaDaBarra", () => {
  it("⭐ há o que rolar: a barra copia posição e largura do quadro e tem a largura TOTAL do conteúdo", () => {
    expect(geometriaDaBarra({ left: 240.4, width: 1380.6 }, 2200, 1380)).toEqual({ left: 240, width: 1381, conteudo: 2200 });
  });

  it("⭐ tudo cabe: não existe barra (nada de trilha vazia no pé da tela)", () => {
    expect(geometriaDaBarra({ left: 0, width: 1400 }, 1400, 1400)).toBeNull();
    // 1px de arredondamento não cria barra
    expect(geometriaDaBarra({ left: 0, width: 1400 }, 1401, 1400)).toBeNull();
  });
});

/** Quadro mínimo que usa o hook, com as medidas que o jsdom não calcula. */
function Quadro({ colunas }: { colunas: number }) {
  const { aoMontarQuadro, aoMontarBarra, geo } = useBarraDeRolagemFixa<HTMLDivElement>(colunas);
  return (
    <div>
      <div
        data-testid="quadro"
        ref={(el) => {
          if (el) {
            Object.defineProperty(el, "scrollWidth", { configurable: true, value: 2200 });
            Object.defineProperty(el, "clientWidth", { configurable: true, value: 1000 });
          }
          aoMontarQuadro(el);
        }}
      />
      {geo && <div data-testid="barra" ref={aoMontarBarra} />}
    </div>
  );
}

/** jsdom não implementa scrollLeft de verdade: um valor guardado + o evento `scroll`. */
function comScrollLeft(el: HTMLElement) {
  let v = 0;
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => v, set: (n: number) => (v = n) });
}

describe("useBarraDeRolagemFixa", () => {
  it("⭐ com mais conteúdo que o quadro, a barra aparece", () => {
    render(<Quadro colunas={7} />);
    expect(screen.getByTestId("barra")).toBeInTheDocument();
  });

  it("⭐ rolar o QUADRO move a barra, e arrastar a BARRA move o quadro", () => {
    render(<Quadro colunas={7} />);
    const quadro = screen.getByTestId("quadro");
    const barra = screen.getByTestId("barra");
    comScrollLeft(quadro);
    comScrollLeft(barra);

    act(() => {
      quadro.scrollLeft = 300;
      quadro.dispatchEvent(new Event("scroll"));
    });
    expect(barra.scrollLeft).toBe(300);

    act(() => {
      barra.scrollLeft = 120;
      barra.dispatchEvent(new Event("scroll"));
    });
    expect(quadro.scrollLeft).toBe(120);
  });
});
