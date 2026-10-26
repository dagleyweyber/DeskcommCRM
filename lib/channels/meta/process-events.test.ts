import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountUpdateEvent } from "./coexistence-webhook";
import type { MetaWebhookSession } from "./session";

const sincronizar = vi.fn();
const registrar = vi.fn();
vi.mock("../health", () => ({ sincronizarSaudeDaConexao: (...a: unknown[]) => sincronizar(...a) }));
vi.mock("../zernio/avisos", () => ({ registrarAviso: (...a: unknown[]) => registrar(...a) }));
vi.mock("./ingest", () => ({ ingestMetaInbound: vi.fn() }));
vi.mock("./coexistence-ingest", () => ({
  ingestContactSync: vi.fn(),
  ingestEcho: vi.fn(),
  ingestHistoryChunk: vi.fn(),
  registrarHistoricoRecusado: vi.fn(),
}));

import { tratarAccountUpdate } from "./process-events";

const session: MetaWebhookSession = {
  id: "sess-1",
  organizationId: "org-1",
  wabaId: "W1",
  phoneNumberId: "PN1",
  connectionMode: "embedded_coexistence",
};

const ev = (p: Partial<AccountUpdateEvent>): AccountUpdateEvent => ({
  kind: "account_update",
  wabaId: "W1",
  event: "X",
  banState: null,
  disconnectReason: null,
  disconnectInitiatedBy: null,
  violationType: null,
  restrictionType: null,
  ...p,
});

function adminFalso() {
  const updates: Array<{ tabela: string; arg: unknown }> = [];
  const admin = {
    from: (tabela: string) => ({
      select: () => {
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        q.order = () => q;
        q.limit = () => q;
        q.maybeSingle = async () => ({
          data:
            tabela === "channel_sessions"
              ? { id: "sess-1", organization_id: "org-1", display_name: "Clínica X", phone_number: "+5581" }
              : { id: "item-1", body: "Nenhuma mensagem entra nem sai." },
          error: null,
        });
        return q;
      },
      update: (arg: unknown) => {
        updates.push({ tabela, arg });
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        return Object.assign(Promise.resolve({ error: null }), q);
      },
    }),
  };
  return { admin: admin as never, updates };
}

beforeEach(() => {
  sincronizar.mockReset();
  registrar.mockReset();
});

describe("tratarAccountUpdate", () => {
  it("⭐ queda: grava channel_sessions.status (a faixa do topo lê dele) e passa pelo trilho de saúde COMO EMPURRÃO", async () => {
    sincronizar.mockResolvedValue("avisado");
    const { admin, updates } = adminFalso();

    const r = await tratarAccountUpdate(
      admin,
      session,
      ev({ event: "PARTNER_REMOVED", disconnectReason: "PRIMARY_INACTIVITY", disconnectInitiatedBy: "SYSTEM" }),
    );

    expect(r).toBe("avisado");
    expect(updates.find((u) => u.tabela === "channel_sessions")!.arg).toEqual({ status: "STOPPED" });
    const args = sincronizar.mock.calls[0]!;
    expect(args[2]).toMatchObject({ status: "STOPPED" });
    expect(args[3]).toBe("Clínica X"); // o apelido da conexão, não o texto do evento
    expect(args[4]).toBe("empurrao"); // a varredura não fecha o que a Meta abriu
  });

  it("o motivo da desconexão é acrescentado ao aviso que acabou de abrir", async () => {
    sincronizar.mockResolvedValue("avisado");
    const { admin, updates } = adminFalso();
    await tratarAccountUpdate(
      admin,
      session,
      ev({ event: "PARTNER_REMOVED", disconnectReason: "PRIMARY_INACTIVITY" }),
    );
    const corpo = (updates.find((u) => u.tabela === "agent_inbox_items")!.arg as { body: string }).body;
    expect(corpo).toContain("Nenhuma mensagem entra nem sai.");
    expect(corpo).toContain("14 dias");
  });

  it("aviso já aberto no episódio não é reescrito (nada de motivo duplicado)", async () => {
    sincronizar.mockResolvedValue("ja_avisado");
    const { admin, updates } = adminFalso();
    await tratarAccountUpdate(
      admin,
      session,
      ev({ event: "PARTNER_REMOVED", disconnectReason: "PRIMARY_INACTIVITY" }),
    );
    expect(updates.some((u) => u.tabela === "agent_inbox_items")).toBe(false);
  });

  it("volta (ACCOUNT_RECONNECTED): WORKING, que é o que resolve o aviso", async () => {
    sincronizar.mockResolvedValue("resolvido");
    const { admin, updates } = adminFalso();
    expect(await tratarAccountUpdate(admin, session, ev({ event: "ACCOUNT_RECONNECTED" }))).toBe("resolvido");
    expect(updates.find((u) => u.tabela === "channel_sessions")!.arg).toEqual({ status: "WORKING" });
  });

  it("restrição: só aviso avulso, e NÃO mexe no status do canal", async () => {
    registrar.mockResolvedValue("criado");
    const { admin, updates } = adminFalso();
    expect(
      await tratarAccountUpdate(admin, session, ev({ event: "ACCOUNT_RESTRICTION", restrictionType: "X" })),
    ).toBe("criado");
    expect(sincronizar).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("evento sem efeito (PARTNER_ADDED): ignorado", async () => {
    const { admin } = adminFalso();
    expect(await tratarAccountUpdate(admin, session, ev({ event: "PARTNER_ADDED" }))).toBe("ignorado");
    expect(sincronizar).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });
});
