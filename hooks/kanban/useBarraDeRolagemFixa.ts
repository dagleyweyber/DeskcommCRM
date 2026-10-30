"use client";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export interface GeometriaDaBarra {
  /** Distância da borda esquerda da JANELA — a barra é `fixed`. */
  left: number;
  /** Largura visível do quadro: a barra tem a mesma, para o polegar ter o mesmo tamanho. */
  width: number;
  /** Largura TOTAL do conteúdo do quadro (o que dá o comprimento da trilha). */
  conteudo: number;
}

/**
 * Onde a barra fica e quanto ela rola. `null` = não há o que rolar (todas as
 * colunas cabem), e então não existe barra nenhuma. Puro (sem DOM): é a conta
 * que decide se a barra aparece e se o polegar tem o tamanho certo.
 */
export function geometriaDaBarra(
  quadro: { left: number; width: number },
  scrollWidth: number,
  clientWidth: number,
): GeometriaDaBarra | null {
  if (scrollWidth <= clientWidth + 1) return null;
  return { left: Math.round(quadro.left), width: Math.round(quadro.width), conteudo: scrollWidth };
}

/**
 * Leva a posição horizontal de `de` para `para`. Função solta, fora do hook, de
 * propósito: o lint de imutabilidade do React reprova atribuir `scrollLeft` a um
 * elemento que veio de `useState` — e aqui é exatamente o que se quer (o DOM é um
 * sistema externo, não estado do React). Só escreve se mudou, o que também evita laço.
 */
export function copiarRolagem(de: HTMLElement, para: HTMLElement): void {
  if (para.scrollLeft !== de.scrollLeft) para.scrollLeft = de.scrollLeft;
}

/**
 * Barra de rolagem HORIZONTAL do quadro do Kanban presa ao pé da janela.
 *
 * O quadro cresce com a coluna mais longa e a página rola na vertical — então a
 * barra nativa fica no fim do quadro, muito abaixo da dobra, e a atendente rolava
 * a tela toda só para achá-la. Mover a barra de lugar não é possível com CSS: ela
 * pertence ao elemento que rola. Então o quadro esconde a dele e esta é uma
 * ESPELHO — uma trilha `fixed` no pé da janela, alinhada ao quadro, que rola junto
 * nos dois sentidos (arrastar a barra move o quadro; rolar o quadro move a barra).
 *
 * Não dá para usar `position: sticky`: o `<main>` do app tem `overflow: auto`, o
 * que o torna o contêiner do sticky, e como quem rola de fato é o documento, ele
 * nunca gruda.
 *
 * Refs por CALLBACK (estado): o quadro só existe depois dos dados, e a barra só
 * quando há o que rolar — com `useRef` os efeitos rodariam uma vez, sem o elemento.
 *
 * `dependencia`: o que muda a largura do conteúdo sem mudar o quadro (nº de colunas).
 */
export function useBarraDeRolagemFixa<T extends HTMLElement>(dependencia: unknown) {
  const [quadro, setQuadro] = useState<T | null>(null);
  const [barra, setBarra] = useState<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<GeometriaDaBarra | null>(null);

  const medir = useCallback(() => {
    if (!quadro) return;
    const proxima = geometriaDaBarra(quadro.getBoundingClientRect(), quadro.scrollWidth, quadro.clientWidth);
    setGeo((atual) =>
      atual === proxima ||
      (atual && proxima && atual.left === proxima.left && atual.width === proxima.width && atual.conteudo === proxima.conteudo)
        ? atual
        : proxima,
    );
  }, [quadro]);

  useLayoutEffect(() => {
    medir();
  }, [medir, dependencia]);

  useEffect(() => {
    if (!quadro) return;
    window.addEventListener("resize", medir);
    // A barra lateral recolhe, o aviso de impersonação aparece, o quadro muda de
    // largura: observar o <body> e o próprio quadro cobre todos.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(medir) : null;
    ro?.observe(document.body);
    ro?.observe(quadro);
    return () => {
      window.removeEventListener("resize", medir);
      ro?.disconnect();
    };
  }, [quadro, medir]);

  // Os dois sentidos. Atribuir o MESMO valor não dispara `scroll`, então não há
  // laço: cada lado só reage quando o outro realmente andou.
  useEffect(() => {
    if (!quadro || !barra) return;
    const doQuadro = () => copiarRolagem(quadro, barra);
    const daBarra = () => copiarRolagem(barra, quadro);
    quadro.addEventListener("scroll", doQuadro, { passive: true });
    barra.addEventListener("scroll", daBarra, { passive: true });
    doQuadro();
    return () => {
      quadro.removeEventListener("scroll", doQuadro);
      barra.removeEventListener("scroll", daBarra);
    };
  }, [quadro, barra, geo?.conteudo]);

  return { aoMontarQuadro: setQuadro, aoMontarBarra: setBarra, geo };
}
