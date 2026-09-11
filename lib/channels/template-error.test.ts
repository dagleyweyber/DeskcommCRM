import { describe, expect, it } from "vitest";

import { ehRecusaDaPlataforma } from "./template-error";

describe("ehRecusaDaPlataforma — 422 (corrigível) vs 503 (gateway)", () => {
  it("reconhece a recusa do canal oficial", () => {
    expect(ehRecusaDaPlataforma("meta_template_failed: 400 nome inválido")).toBe(true);
  });

  it("reconhece a recusa do canal intermediado", () => {
    expect(ehRecusaDaPlataforma("zernio_template_failed: 400 nome inválido")).toBe(true);
  });

  it("uma falha de rede/timeout NÃO é recusa da plataforma — fica como upstream", () => {
    expect(ehRecusaDaPlataforma("fetch failed")).toBe(false);
    expect(ehRecusaDaPlataforma("meta_not_configured: sem credencial")).toBe(false);
    expect(ehRecusaDaPlataforma("")).toBe(false);
  });
});
