import { describe, expect, it } from "vitest";

import { resumeEnvios, type LinhaDeEnvio } from "./resumo-de-envios";

const SEM_PAGINA =
  'http_400: {"error":{"code":100,"error_subcode":2804131,"is_transient":false,"error_user_title":"x"}}';

const linha = (lead: string, status: string, quando: string, erro: string | null = null, evento = "Purchase"): LinhaDeEnvio => ({
  lead_id: lead,
  event_name: evento,
  status,
  meta_error: erro,
  created_at: quando,
});

describe("resumeEnvios", () => {
  it("⭐ conta LEAD, não tentativa: 5 recusas do mesmo lead = 1 lead recusado", () => {
    const linhas = [1, 2, 3, 4, 5].map((i) => linha("A", "failed", `2026-10-2${i}T00:00:00Z`, SEM_PAGINA));
    const [r] = resumeEnvios(linhas);
    expect(r).toMatchObject({ evento: "Purchase", aceitos: 0, recusados: 1 });
    expect(r!.motivos[0]).toMatchObject({ leads: 1 });
    expect(r!.motivos[0]!.oQueFazer).toMatch(/associe este conjunto de dados/);
  });

  it("⭐ lead que falhou e depois foi aceito conta como ACEITO", () => {
    const [r] = resumeEnvios([
      linha("A", "failed", "2026-10-20T00:00:00Z", "http_502: Bad Gateway"),
      linha("A", "sent", "2026-10-20T00:05:00Z"),
    ]);
    expect(r).toMatchObject({ aceitos: 1, recusados: 0, motivos: [] });
  });

  it("separa por evento e agrupa motivos, mais frequente primeiro", () => {
    const r = resumeEnvios([
      linha("A", "failed", "2026-10-20T00:00:00Z", SEM_PAGINA),
      linha("B", "failed", "2026-10-20T00:00:00Z", SEM_PAGINA),
      linha("C", "failed", "2026-10-20T00:00:00Z", "http_502: Bad Gateway"),
      linha("D", "sent", "2026-10-20T00:00:00Z", null, "Lead"),
    ]);
    const purchase = r.find((x) => x.evento === "Purchase")!;
    expect(purchase.recusados).toBe(3);
    expect(purchase.motivos.map((m) => m.leads)).toEqual([2, 1]);
    expect(r.find((x) => x.evento === "Lead")).toMatchObject({ aceitos: 1, recusados: 0 });
  });

  it("o motivo de um lead é o do erro MAIS RECENTE dele", () => {
    const [r] = resumeEnvios([
      linha("A", "failed", "2026-10-20T00:00:00Z", "http_502: Bad Gateway"),
      linha("A", "failed", "2026-10-21T00:00:00Z", SEM_PAGINA),
    ]);
    expect(r!.motivos).toHaveLength(1);
    expect(r!.motivos[0]!.oQueFazer).toMatch(/associe/);
  });

  it("sem envios → lista vazia", () => {
    expect(resumeEnvios([])).toEqual([]);
  });
});
