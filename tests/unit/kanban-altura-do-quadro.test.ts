import { describe, expect, it } from "vitest";

import { ALTURA_MINIMA_DO_QUADRO, alturaDisponivel } from "@/hooks/kanban/useAlturaDoQuadro";

/**
 * A conta que prende o quadro do Kanban à janela. É ela que decide se a barra de
 * rolagem horizontal aparece no pé da tela ou lá no fim da página.
 */
describe("alturaDisponivel", () => {
  it("⭐ do topo do quadro até o pé da janela, menos a folga do <main>", () => {
    // janela 900, quadro começa em 220 → 900 - 220 - 24
    expect(alturaDisponivel(220, 900)).toBe(656);
  });

  it("⭐ quanto mais coisa acima (filtros, aviso de impersonação), menos altura — o pé continua na janela", () => {
    const semAviso = alturaDisponivel(220, 900);
    const comAviso = alturaDisponivel(220 + 48, 900);
    expect(semAviso - comAviso).toBe(48);
  });

  it("janela muito baixa: não encolhe além do piso (a página rola, como antes)", () => {
    expect(alturaDisponivel(500, 600)).toBe(ALTURA_MINIMA_DO_QUADRO);
  });

  it("valor quebrado vira inteiro (sem sub-pixel que dispare nova medição)", () => {
    expect(alturaDisponivel(220.6, 900)).toBe(655);
  });
});
