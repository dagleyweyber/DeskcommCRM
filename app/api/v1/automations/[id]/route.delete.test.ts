/**
 * DELETE /api/v1/automations/[id] — excluir uma automação.
 *
 * O dublê aplica os filtros de verdade (`eq`, `is`): automação de OUTRA organização, ou já excluída,
 * só "não aparece" se a rota filtrar `organization_id` e `archived_at`. Um stub que devolve a linha
 * sempre deixaria os dois bloqueios mudos e os testes verdes.
 *
 * O que importa: excluir NÃO apaga a linha (o histórico e o elo das respostas dos pacientes dependem
 * dela) e deixa a automação pausada na mesma escrita, para o despachante parar no mesmo instante.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const AUTO = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;

function montarDb(linhas: Linha[]) {
  const apagadas: string[] = [];
  class Q implements PromiseLike<unknown> {
    private preds: Array<(l: Linha) => boolean> = [];
    private patch: Linha | null = null;
    private devolver = false;
    update(patch: Linha): this {
      this.patch = patch;
      return this;
    }
    delete(): this {
      apagadas.push("delete chamado");
      return this;
    }
    select(): this {
      this.devolver = true;
      return this;
    }
    eq(coluna: string, valor: unknown): this {
      this.preds.push((l) => l[coluna] === valor);
      return this;
    }
    is(coluna: string, valor: null): this {
      this.preds.push((l) => (l[coluna] ?? null) === valor);
      return this;
    }
    then<R1 = unknown, R2 = never>(
      ok?: ((v: unknown) => R1 | PromiseLike<R1>) | null,
      err?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      const alvo = linhas.filter((l) => this.preds.every((p) => p(l)));
      if (this.patch) for (const l of alvo) Object.assign(l, this.patch);
      return Promise.resolve({ data: this.devolver ? alvo.map((l) => ({ ...l })) : null, error: null }).then(ok, err);
    }
  }
  const admin = { from: vi.fn(() => new Q()) };
  return { admin, linhas, apagadas };
}

const chamar = (id = AUTO) => DELETE(new Request("http://x"), { params: Promise.resolve({ id }) });
const automacao = (extra: Linha = {}): Linha => ({
  id: AUTO,
  organization_id: ORG,
  name: "Confirmação Agendamento Laser",
  status: "paused",
  archived_at: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER },
  } as never);
});

describe("DELETE /api/v1/automations/[id]", () => {
  it("⭐ exclui: preenche archived_at, deixa PAUSADA, NÃO apaga a linha e audita", async () => {
    const db = montarDb([automacao({ status: "active" })]);
    vi.mocked(createAdminClient).mockReturnValue(db.admin as never);

    const res = await chamar();

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: true });
    expect(db.linhas).toHaveLength(1); // a linha continua — o histórico de envios depende dela
    expect(db.apagadas).toEqual([]);
    expect(db.linhas[0]).toMatchObject({ status: "paused" });
    expect(typeof db.linhas[0]!.archived_at).toBe("string");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "automation.deleted",
        organizationId: ORG,
        resourceId: AUTO,
        metadata: expect.objectContaining({ nome: "Confirmação Agendamento Laser", historico_mantido: true }),
      }),
    );
  });

  it("⭐ automação de OUTRA organização é 404 e não é tocada", async () => {
    const db = montarDb([automacao({ organization_id: OUTRA_ORG })]);
    vi.mocked(createAdminClient).mockReturnValue(db.admin as never);

    const res = await chamar();

    expect(res.status).toBe(404);
    expect(db.linhas[0]!.archived_at).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("excluir de novo (outra aba) é 404 e não audita duas vezes", async () => {
    const db = montarDb([automacao({ archived_at: "2026-11-10T00:00:00.000Z" })]);
    vi.mocked(createAdminClient).mockReturnValue(db.admin as never);

    expect((await chamar()).status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("id que não é uuid é 404, sem consultar o banco", async () => {
    const db = montarDb([automacao()]);
    vi.mocked(createAdminClient).mockReturnValue(db.admin as never);

    expect((await chamar("nao-e-uuid")).status).toBe(404);
    expect(db.admin.from).not.toHaveBeenCalled();
  });

  it("sem permissão de gerente, devolve a resposta do guard e não toca no banco", async () => {
    const proibido = new Response("{}", { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: proibido } as never);
    const db = montarDb([automacao()]);
    vi.mocked(createAdminClient).mockReturnValue(db.admin as never);

    expect(await chamar()).toBe(proibido);
    expect(db.admin.from).not.toHaveBeenCalled();
  });
});
