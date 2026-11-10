import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountUpdateEvent } from "./coexistence-webhook";
import type { MetaWebhookSession } from "./session";

const sincronizar = vi.fn();
const registrar = vi.fn();
vi.mock("../health", () => ({ sincronizarSaudeDaConexao: (...a: unknown[]) => sincronizar(...a) }));
vi.mock("../zernio/avisos", () => ({ registrarAviso: (...a: unknown[]) => registrar(...a) }));
vi.mock("./ingest", () => ({ ingestMetaInbound: vi.fn() }));
// A parada das campanhas tem teste próprio (`avisos-de-qualidade.test.ts`); aqui só o roteamento.
const pausarPorConta = vi.fn(async (..._a: unknown[]) => 0);
vi.mock("./avisos-de-qualidade", () => ({
  aplicarAlertaDaConta: vi.fn(async () => "account_alert"),
  aplicarQualidadeDoModelo: vi.fn(async () => "template_quality"),
  aplicarQualidadeDoNumero: vi.fn(async () => "phone_quality"),
  pausarPorAvisoDaConta: (...a: unknown[]) => pausarPorConta(...a),
  pausarPorEstadoDoModelo: vi.fn(async () => 0),
}));
vi.mock("./coexistence-ingest", () => ({
  ingestContactSync: vi.fn(),
  ingestEcho: vi.fn(),
  ingestHistoryChunk: vi.fn(),
  registrarHistoricoRecusado: vi.fn(),
}));

import { processarEventosMeta, tratarAccountUpdate } from "./process-events";

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
        const registro: { tabela: string; arg: unknown; filtros?: unknown[][] } = { tabela, arg };
        updates.push(registro);
        const q: Record<string, unknown> = {};
        for (const m of ["eq", "in", "is"]) {
          q[m] = (...a: unknown[]) => {
            (registro.filtros ??= []).push([m, ...a]);
            return q;
          };
        }
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

describe("processarEventosMeta — categoria do template no espelho", () => {
  const status = {
    kind: "template_status" as const,
    wabaId: "W1",
    templateName: "campanha_11_11",
    templateLanguage: "pt_BR",
    event: "APPROVED",
    reason: null,
  };

  it("⭐ aprovação com categoria trocada pela Meta grava a categoria decidida", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({
      admin,
      session,
      eventos: [{ ...status, category: "MARKETING" }],
      requestId: "r",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      tabela: "meta_templates",
      arg: { status: "APPROVED", category: "MARKETING" },
    });
  });

  it("aviso sem categoria NÃO apaga a que já estava gravada", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({ admin, session, eventos: [{ ...status, category: null }], requestId: "r" });
    expect(updates[0]!.arg).not.toHaveProperty("category");
  });

  it("⭐ troca de categoria concluída atualiza o espelho e aparece no desfecho", async () => {
    const { admin, updates } = adminFalso();
    const desfechos = await processarEventosMeta({
      admin,
      session,
      eventos: [
        {
          kind: "template_category",
          wabaId: "W1",
          templateName: "campanha_11_11",
          templateLanguage: "pt_BR",
          previousCategory: "UTILITY",
          newCategory: "MARKETING",
        },
      ],
      requestId: "r",
    });
    expect(updates).toEqual([
      expect.objectContaining({ tabela: "meta_templates", arg: expect.objectContaining({ category: "MARKETING" }) }),
    ]);
    expect(desfechos).toEqual(["template_category:UTILITY->MARKETING"]);
  });

  it("evento de OUTRA WABA não toca no espelho desta organização", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({
      admin,
      session,
      eventos: [{ ...status, wabaId: "OUTRA", category: "MARKETING" }],
      requestId: "r",
    });
    expect(updates).toEqual([]);
  });
});

describe("processarEventosMeta — entregue e lida (status só sobe)", () => {
  const status = (s: string) => ({
    kind: "message_status" as const,
    wabaId: "W1",
    externalId: "wamid.A",
    status: s,
    recipient: null,
    errorCode: null,
    errorTitle: null,
    errorMessage: null,
    errorDetails: null,
    timestamp: new Date("2026-11-10T15:00:00Z"),
  });

  it("⭐ entregue grava `delivered` + `delivered_at`, só sobre quem ainda não passou disso", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({ admin, session, eventos: [status("delivered")], requestId: "r" });
    expect(updates[0]).toMatchObject({
      tabela: "messages",
      arg: { status: "delivered", delivered_at: "2026-11-10T15:00:00.000Z" },
    });
    expect((updates[0] as { filtros: unknown[][] }).filtros).toContainEqual(["in", "status", ["queued", "sending", "sent"]]);
  });

  it("⭐ lida grava `read` (também sobre entregue) e completa `delivered_at` se a entregue nunca chegou", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({ admin, session, eventos: [status("read")], requestId: "r" });
    expect(updates[0]).toMatchObject({ tabela: "messages", arg: { status: "read", read_at: "2026-11-10T15:00:00.000Z" } });
    expect((updates[0] as { filtros: unknown[][] }).filtros).toContainEqual([
      "in", "status", ["queued", "sending", "sent", "delivered"],
    ]);
    expect(updates[1]).toMatchObject({ tabela: "messages", arg: { delivered_at: "2026-11-10T15:00:00.000Z" } });
    expect((updates[1] as { filtros: unknown[][] }).filtros).toContainEqual(["is", "delivered_at", null]);
  });

  it("`sent` atrasado não rebaixa a mensagem que já foi lida", async () => {
    const { admin, updates } = adminFalso();
    await processarEventosMeta({ admin, session, eventos: [status("sent")], requestId: "r" });
    expect((updates[0] as { filtros: unknown[][] }).filtros).toContainEqual(["in", "status", ["queued", "sending"]]);
  });
});
