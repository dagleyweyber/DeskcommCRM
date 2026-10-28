import { describe, expect, it } from "vitest";

import { AMOSTRA_MINIMA, TAXA_MINIMA_ESPERADA, resumeCliques } from "./resumo-de-cliques";

describe("resumeCliques", () => {
  it("sem cliques: taxa nula e orientação para conferir o script e o link", () => {
    const r = resumeCliques(0, 0);
    expect(r.taxa).toBeNull();
    expect(r.leitura).toMatch(/Nenhum clique/);
  });

  it("⭐ amostra pequena não conclui nada (3 de 3 não é 'funcionando')", () => {
    const r = resumeCliques(AMOSTRA_MINIMA - 1, AMOSTRA_MINIMA - 1);
    expect(r.leitura).toMatch(/ainda são poucos/);
  });

  it("⭐ taxa baixa com amostra suficiente: diz que o código está se perdendo e o que conferir", () => {
    const r = resumeCliques(100, TAXA_MINIMA_ESPERADA - 1);
    expect(r.taxa).toBe(TAXA_MINIMA_ESPERADA - 1);
    expect(r.leitura).toMatch(/apagada ou editada/);
  });

  it("taxa boa: funcionando", () => {
    const r = resumeCliques(100, 60);
    expect(r).toMatchObject({ cliques: 100, ligados: 60, taxa: 60 });
    expect(r.leitura).toMatch(/funcionando/);
  });

  it("⭐ números incoerentes não quebram: ligados maior que cliques é limitado; negativos viram zero", () => {
    expect(resumeCliques(10, 50)).toMatchObject({ ligados: 10, taxa: 100 });
    expect(resumeCliques(-5, -1)).toMatchObject({ cliques: 0, ligados: 0, taxa: null });
  });
});
