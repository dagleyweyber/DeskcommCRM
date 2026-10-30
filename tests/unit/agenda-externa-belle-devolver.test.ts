import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarClienteBelle, FalhaNoBelle, TokenBelleInvalido } from "@/lib/agenda-externa/belle/api";
import { devolverConfirmacoes } from "@/lib/agenda-externa/devolver-confirmacao";

const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const ORG = "org-1";

/** Admin falso: registra filtros e updates; devolve os candidatos no `limit`. */
function adminFalso(candidatos: { id: string; external_id: string; revision: number }[]) {
  const filtros: [string, unknown][] = [];
  const updates: { patch: Record<string, unknown>; filtros: [string, unknown][] }[] = [];
  const admin = {
    from: () => ({
      select: () => {
        const q: Record<string, unknown> = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
          not: () => q,
          gt: () => q,
          order: () => q,
          limit: () => Promise.resolve({ data: candidatos }),
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const f: [string, unknown][] = [];
        const u = {
          eq: (c: string, v: unknown) => (f.push([c, v]), u),
          then: (ok: (v: { error: null }) => unknown) => {
            updates.push({ patch, filtros: f });
            return Promise.resolve({ error: null }).then(ok);
          },
        };
        return u;
      },
    }),
  };
  return { admin: admin as never, filtros, updates };
}

const C1 = { id: "a1", external_id: "76816896", revision: 4 };
const C2 = { id: "a2", external_id: "74199488", revision: 1 };

beforeEach(() => audit.mockReset());

describe("devolverConfirmacoes — cliente confirmou no WhatsApp → Belle", () => {
  it("⭐ manda 'Confirmado' pelo código do Belle e espelha o status localmente", async () => {
    const { admin, updates } = adminFalso([C1]);
    const alterarStatus = vi.fn().mockResolvedValue({ sucesso: true, msg: "" });

    const r = await devolverConfirmacoes(admin, ORG, { alterarStatus });

    expect(alterarStatus).toHaveBeenCalledWith("76816896", "Confirmado");
    expect(r).toEqual({ devolvidas: 1, recusadas: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch).toEqual({ external_status: "Confirmado", revision: 5 });
    // Trava otimista: só atualiza se ninguém mexeu no compromisso no meio-tempo.
    expect(updates[0]!.filtros).toContainEqual(["revision", 4]);
    expect(updates[0]!.filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "calendar_appointment.external_confirmed", resourceId: "a1" }));
  });

  it("só pede compromissos do Belle, confirmados, que o Belle ainda mostra como 'Marcado'", async () => {
    const { admin, filtros } = adminFalso([]);
    await devolverConfirmacoes(admin, ORG, { alterarStatus: vi.fn() });
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["external_provider", "belle"],
        ["status", "confirmed"],
        ["external_status", "Marcado"],
      ]),
    );
  });

  it("recusa do Belle não mexe no compromisso e é contada", async () => {
    const { admin, updates } = adminFalso([C1]);
    const alterarStatus = vi.fn().mockResolvedValue({ sucesso: false, msg: "Agendamento com data inferior a data atual." });

    const r = await devolverConfirmacoes(admin, ORG, { alterarStatus });

    expect(r).toEqual({ devolvidas: 0, recusadas: 1 });
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("Belle fora do ar encerra a leva sem lançar e sem tentar os outros", async () => {
    const { admin, updates } = adminFalso([C1, C2]);
    const alterarStatus = vi.fn().mockRejectedValue(new FalhaNoBelle("Sem resposta do Belle (TimeoutError)."));

    const r = await devolverConfirmacoes(admin, ORG, { alterarStatus });

    expect(alterarStatus).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ devolvidas: 0, recusadas: 0 });
    expect(updates).toHaveLength(0);
  });

  it("token recusado sobe para quem chama (o sincronizador marca a conexão como inválida)", async () => {
    const { admin } = adminFalso([C1]);
    const alterarStatus = vi.fn().mockRejectedValue(new TokenBelleInvalido());
    await expect(devolverConfirmacoes(admin, ORG, { alterarStatus })).rejects.toBeInstanceOf(TokenBelleInvalido);
  });

  it("uma recusa não impede os próximos", async () => {
    const { admin, updates } = adminFalso([C1, C2]);
    const alterarStatus = vi
      .fn()
      .mockResolvedValueOnce({ sucesso: false, msg: "Status não permite alteração." })
      .mockResolvedValueOnce({ sucesso: true, msg: "" });

    const r = await devolverConfirmacoes(admin, ORG, { alterarStatus });

    expect(r).toEqual({ devolvidas: 1, recusadas: 1 });
    expect(updates.map((u) => u.patch.revision)).toEqual([2]);
  });
});

describe("criarClienteBelle.alterarStatus — PUT agenda/status", () => {
  const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

  it("⭐ PUT com codConsulta numérico, novoStatus e o token no cabeçalho", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta({ sucesso: true, msg: "" }));
    const r = await criarClienteBelle({ token: "tok", fetchImpl }).alterarStatus("12334", "Confirmado");

    expect(r).toEqual({ sucesso: true, msg: "" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(/\/IntegracaoExterna\/v1\.0\/agenda\/status$/);
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("tok");
    expect(JSON.parse(init.body)).toEqual({ codConsulta: 12334, novoStatus: "Confirmado" });
  });

  it("recusa (200 com sucesso:false) devolve o motivo do Belle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta({ sucesso: false, msg: "Agendamento com data inferior a data atual." }));
    const r = await criarClienteBelle({ token: "t", fetchImpl }).alterarStatus("1", "Confirmado");
    expect(r).toEqual({ sucesso: false, msg: "Agendamento com data inferior a data atual." });
  });

  it("resposta sem 'sucesso' não conta como sucesso", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta({ ok: true }));
    const r = await criarClienteBelle({ token: "t", fetchImpl }).alterarStatus("1", "Confirmado");
    expect(r.sucesso).toBe(false);
  });

  it("401 → token inválido; 500 → falha do Belle", async () => {
    await expect(
      criarClienteBelle({ token: "t", fetchImpl: vi.fn().mockResolvedValue(resposta({}, 401)) }).alterarStatus("1", "Confirmado"),
    ).rejects.toBeInstanceOf(TokenBelleInvalido);
    await expect(
      criarClienteBelle({ token: "t", fetchImpl: vi.fn().mockResolvedValue(resposta({}, 500)) }).alterarStatus("1", "Confirmado"),
    ).rejects.toBeInstanceOf(FalhaNoBelle);
  });

  it("código que não é número nem chega a chamar o Belle", async () => {
    const fetchImpl = vi.fn();
    const r = await criarClienteBelle({ token: "t", fetchImpl }).alterarStatus("abc", "Confirmado");
    expect(r.sucesso).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
