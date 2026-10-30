"use client";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Piso: numa janela muito baixa o quadro não encolhe além disto — a página rola, como antes. */
export const ALTURA_MINIMA_DO_QUADRO = 360;

/**
 * Altura que o quadro pode ocupar: do topo dele até o pé da janela, menos a
 * folga do `<main>` (p-6 = 24px).
 *
 * Puro de propósito (sem DOM): a conta é a parte que dá errado em silêncio.
 */
export function alturaDisponivel(topoDoQuadro: number, alturaDaJanela: number, folgaInferior = 24): number {
  return Math.max(ALTURA_MINIMA_DO_QUADRO, Math.floor(alturaDaJanela - topoDoQuadro - folgaInferior));
}

/**
 * Prende o quadro do Kanban à altura da JANELA, para que a barra de rolagem
 * horizontal fique sempre visível (e as colunas rolem por dentro).
 *
 * Por que medir em vez de `calc(100vh - X)`: o que fica acima do quadro muda —
 * barra superior, aviso de "entrou como…" (impersonação), cabeçalho da página,
 * filtros que quebram em duas linhas no celular. Um `X` fixo erra em pelo menos
 * um desses casos, e erra para o lado ruim (a barra some de novo).
 *
 * `topo` é medido com `getBoundingClientRect` — relativo à janela, então a conta
 * vale mesmo que a página já tenha rolado um pouco.
 */
export function useAlturaDoQuadro<T extends HTMLElement>() {
  // Ref por CALLBACK (estado), não useRef: o quadro só existe depois que os dados
  // chegam — com useRef o efeito rodava uma vez, com o elemento ainda ausente, e
  // nunca mais media.
  const [el, setEl] = useState<T | null>(null);
  const [altura, setAltura] = useState<number | null>(null);

  const medir = useCallback(() => {
    if (!el) return;
    const topo = el.getBoundingClientRect().top;
    const proxima = alturaDisponivel(topo, window.innerHeight);
    setAltura((atual) => (atual === proxima ? atual : proxima));
  }, [el]);

  useLayoutEffect(() => {
    medir();
  }, [medir]);

  useEffect(() => {
    if (!el) return;
    window.addEventListener("resize", medir);
    // O que está ACIMA do quadro cresce/encolhe sem a janela mudar (filtros,
    // aviso de impersonação): observar o <body> cobre todos, e o `setAltura`
    // só muda de valor quando a conta muda — sem laço.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(medir) : null;
    ro?.observe(document.body);
    return () => {
      window.removeEventListener("resize", medir);
      ro?.disconnect();
    };
  }, [el, medir]);

  // Não se chama `ref` de propósito: o lint de refs do React trata qualquer
  // propriedade com esse nome como ref mutável e reprova o uso na renderização.
  return { aoMontar: setEl, altura };
}
