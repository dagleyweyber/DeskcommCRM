import { describe, expect, it } from "vitest";

import { proximoCompromissoPorContato, type CompromissoDoContato } from "./next-meeting";

const AGORA = new Date("2026-10-27T15:00:00Z"); // 12:00 em São Paulo

function c(contato: string, inicio: string, status: CompromissoDoContato["status"] = "pending", minutos = 60): CompromissoDoContato {
  return {
    contact_id: contato,
    starts_at: inicio,
    ends_at: new Date(new Date(inicio).getTime() + minutos * 60_000).toISOString(),
    status,
  };
}

describe("proximoCompromissoPorContato — o card do Kanban lê a Agenda", () => {
  it("⭐ o próximo compromisso em aberto do contato aparece, com o status", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-11-05T13:00:00Z", "confirmed")], AGORA);
    expect(m.get("A")).toEqual({ starts_at: "2026-11-05T13:00:00Z", status: "confirmed" });
  });

  it("⭐ cancelado na Agenda some do card (antes ficava mostrando)", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-11-05T13:00:00Z", "cancelled")], AGORA);
    expect(m.has("A")).toBe(false);
  });

  it("⭐ remarcado: vale o compromisso novo (o antigo foi cancelado)", () => {
    const m = proximoCompromissoPorContato(
      [c("A", "2026-11-01T13:00:00Z", "cancelled"), c("A", "2026-11-08T13:00:00Z")],
      AGORA,
    );
    expect(m.get("A")?.starts_at).toBe("2026-11-08T13:00:00Z");
  });

  it("com dois futuros, mostra o mais próximo", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-12-10T13:00:00Z"), c("A", "2026-11-05T13:00:00Z")], AGORA);
    expect(m.get("A")?.starts_at).toBe("2026-11-05T13:00:00Z");
  });

  it("'Não confirmado' continua no card — a vaga ainda está reservada", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-11-05T13:00:00Z", "declined")], AGORA);
    expect(m.get("A")?.status).toBe("declined");
  });

  it("visita de hoje cedo sem desfecho continua no card até alguém registrar presença", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-10-27T12:00:00Z")], AGORA);
    expect(m.get("A")?.starts_at).toBe("2026-10-27T12:00:00Z");
    expect(proximoCompromissoPorContato([c("A", "2026-10-27T12:00:00Z", "completed")], AGORA).has("A")).toBe(false);
  });

  it("visita antiga (mais de 24h) sem desfecho não fica eternamente no card", () => {
    expect(proximoCompromissoPorContato([c("A", "2026-10-20T13:00:00Z")], AGORA).has("A")).toBe(false);
  });

  it("um futuro vence um passado sem desfecho", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-10-27T12:00:00Z"), c("A", "2026-11-05T13:00:00Z")], AGORA);
    expect(m.get("A")?.starts_at).toBe("2026-11-05T13:00:00Z");
  });

  it("contatos independentes", () => {
    const m = proximoCompromissoPorContato([c("A", "2026-11-05T13:00:00Z"), c("B", "2026-11-06T13:00:00Z", "no_show")], AGORA);
    expect(m.has("A")).toBe(true);
    expect(m.has("B")).toBe(false);
  });
});
