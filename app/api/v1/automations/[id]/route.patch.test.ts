/**
 * PATCH /api/v1/automations/[id] — editar uma automação sem recriá-la.
 *
 * O dublê aplica os filtros de verdade (`eq`, `neq`, `is`, `in`, `gt`...): uma
 * automação, um modelo ou um serviço de OUTRA organização só "não aparece" se a rota
 * filtrar `organization_id`; e "há outra ativa no mesmo momento" só é achado se o
 * filtro de momento for aplicado. Um stub que devolve a linha sempre deixaria os
 * dois bloqueios mudos e os testes verdes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const AUTO = "55555555-5555-4555-8555-555555555555";
const OUTRA_AUTO = "66666666-6666-4666-8666-666666666666";
const SERVICO_A = "77777777-7777-4777-8777-777777777777";
const SERVICO_B = "88888888-8888-4888-8888-888888888888";
const AGENDAMENTO = "99999999-9999-4999-8999-999999999999";

type Linha = Record<string, unknown>;

const botoes = (...textos: string[]) => ({
  type: "BUTTONS",
  buttons: textos.map((text) => ({ type: "QUICK_REPLY", text })),
});

function montarDb(over: { status?: string; confirmacaoPendente?: boolean; outraAtiva?: boolean } = {}) {
  const daqui = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();
  const tabelas: Record<string, Linha[]> = {
    whatsapp_template_automations: [
      {
        id: AUTO,
        organization_id: ORG,
        status: over.status ?? "active",
        trigger_kind: "appointment_reminder",
        channel_session_id: CANAL,
        name: "Confirmação_Agenda_Laser",
        template_name: "lembrete",
        template_language: "pt_BR",
        variable_mapping: {},
        event_type_id: SERVICO_A,
        timing_kind: "day_of_8am",
        timing_value: null,
        confirm_button_text: "Confirmar",
        decline_button_text: "Remarcar",
      },
      ...(over.outraAtiva
        ? [
            {
              id: OUTRA_AUTO,
              organization_id: ORG,
              status: "active",
              trigger_kind: "appointment_reminder",
              name: "Corporal",
              event_type_id: SERVICO_B,
              timing_kind: "day_of_8am",
              timing_value: null,
            },
          ]
        : []),
    ],
    channel_sessions: [{ id: CANAL, organization_id: ORG, status: "WORKING" }],
    meta_templates: [
      {
        organization_id: ORG,
        channel_session_id: CANAL,
        name: "lembrete",
        language: "pt_BR",
        status: "APPROVED",
        parameter_format: "positional",
        components: [{ type: "BODY", text: "Seu horário está marcado." }, botoes("Confirmar", "Remarcar")],
      },
      {
        organization_id: ORG,
        channel_session_id: CANAL,
        name: "novo_modelo",
        language: "pt_BR",
        status: "APPROVED",
        parameter_format: "positional",
        components: [{ type: "BODY", text: "Seu horário está marcado." }, botoes("Sim", "Não vou")],
      },
      {
        organization_id: ORG,
        channel_session_id: CANAL,
        name: "reprovado",
        language: "pt_BR",
        status: "REJECTED",
        parameter_format: "positional",
        components: [{ type: "BODY", text: "x" }],
      },
    ],
    calendar_event_types: [
      { id: SERVICO_A, organization_id: ORG, is_active: true },
      { id: SERVICO_B, organization_id: ORG, is_active: true },
    ],
    whatsapp_template_automation_sends: over.confirmacaoPendente
      ? [
          {
            automation_id: AUTO,
            organization_id: ORG,
            status: "sent",
            appointment_id: AGENDAMENTO,
            sent_at: new Date().toISOString(),
          },
        ]
      : [],
    calendar_appointments: over.confirmacaoPendente
      ? [{ id: AGENDAMENTO, organization_id: ORG, status: "pending", starts_at: daqui(1) }]
      : [],
  };
  const escritas: Array<{ table: string; patch: Linha; filtros: Array<[string, unknown]> }> = [];

  class Q implements PromiseLike<unknown> {
    private preds: Array<(l: Linha) => boolean> = [];
    private filtros: Array<[string, unknown]> = [];
    private patch: Linha | null = null;
    private contar = false;
    constructor(private readonly table: string) {}
    select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
      this.contar = Boolean(opts?.count);
      return this;
    }
    update(p: Linha): this {
      this.patch = p;
      return this;
    }
    eq(c: string, v: unknown): this {
      this.filtros.push([c, v]);
      this.preds.push((l) => l[c] === v);
      return this;
    }
    neq(c: string, v: unknown): this {
      this.preds.push((l) => l[c] !== v);
      return this;
    }
    is(c: string, v: unknown): this {
      this.preds.push((l) => (l[c] ?? null) === v);
      return this;
    }
    not(c: string, _op: string, v: unknown): this {
      this.preds.push((l) => (l[c] ?? null) !== v);
      return this;
    }
    gte(c: string, v: string): this {
      this.preds.push((l) => String(l[c]) >= v);
      return this;
    }
    gt(c: string, v: string): this {
      this.preds.push((l) => String(l[c]) > v);
      return this;
    }
    in(c: string, v: unknown[]): this {
      this.preds.push((l) => v.includes(l[c]));
      return this;
    }
    limit(): this {
      return this;
    }
    private linhas(): Linha[] {
      return (tabelas[this.table] ?? []).filter((l) => this.preds.every((p) => p(l)));
    }
    private resolver(unica: boolean): { data: unknown; count?: number; error: null } {
      const achadas = this.linhas();
      if (this.patch) {
        escritas.push({ table: this.table, patch: this.patch, filtros: this.filtros });
        for (const l of achadas) Object.assign(l, this.patch);
        return { data: null, error: null };
      }
      if (this.contar) return { data: null, count: achadas.length, error: null };
      if (!unica) return { data: achadas.map((l) => ({ ...l })), error: null };
      return { data: achadas[0] ? { ...achadas[0] } : null, error: null };
    }
    maybeSingle() {
      return Promise.resolve(this.resolver(true));
    }
    then<R1 = unknown, R2 = never>(
      res?: ((v: unknown) => R1 | PromiseLike<R1>) | null,
      rej?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.resolver(false)).then(res, rej);
    }
  }

  vi.mocked(createAdminClient).mockReturnValue({ from: (t: string) => new Q(t) } as never);
  return { tabelas, escritas };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/automations/${AUTO}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = (id = AUTO) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER },
    org: { orgId: ORG },
  } as never);
});

describe("PATCH /automations/[id]", () => {
  it("⭐ renomeia uma automação ATIVA sem recriar: só o nome muda, filtrando pela organização, e audita o campo", async () => {
    const { tabelas, escritas } = montarDb();
    const res = await PATCH(req({ name: "Confirmação Laser (nova)" }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.name).toBe("Confirmação Laser (nova)");
    expect(tabelas.whatsapp_template_automations![0]!.status).toBe("active");
    expect(escritas[0]!.filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "automation.updated",
        metadata: expect.objectContaining({ campos: ["name"] }),
      }),
    );
  });

  it("sem mudança real não grava nem audita", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ name: "Confirmação_Agenda_Laser" }), ctx());
    expect(res.status).toBe(200);
    expect(escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("⭐ automação de OUTRA organização é 404 e nada é gravado", async () => {
    const { escritas } = montarDb();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER },
      org: { orgId: OUTRA_ORG },
    } as never);
    const res = await PATCH(req({ name: "Invasora" }), ctx());
    expect(res.status).toBe(404);
    expect(escritas).toEqual([]);
  });

  it("corpo vazio e campo que não é editável (canal) são recusados", async () => {
    montarDb();
    expect((await PATCH(req({}), ctx())).status).toBe(422);
    expect((await PATCH(req({ channel_session_id: OUTRA_AUTO }), ctx())).status).toBe(422);
    expect((await PATCH(req({ trigger_kind: "appointment_reminder" }), ctx())).status).toBe(422);
  });

  it("⭐ trocar os botões com confirmação AGUARDANDO resposta é recusado (a resposta deixaria de confirmar)", async () => {
    const { escritas, tabelas } = montarDb({ confirmacaoPendente: true });
    const res = await PATCH(
      req({
        template_name: "novo_modelo",
        template_language: "pt_BR",
        confirm_button_text: "Sim",
        decline_button_text: "Não vou",
      }),
      ctx(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/aguardando resposta/);
    expect(escritas).toEqual([]);
    expect(tabelas.whatsapp_template_automations![0]!.confirm_button_text).toBe("Confirmar");
  });

  it("trocar os botões SEM confirmação aguardando é aceito", async () => {
    const { tabelas } = montarDb({ confirmacaoPendente: false });
    const res = await PATCH(
      req({
        template_name: "novo_modelo",
        template_language: "pt_BR",
        confirm_button_text: "Sim",
        decline_button_text: "Não vou",
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.confirm_button_text).toBe("Sim");
    expect(tabelas.whatsapp_template_automations![0]!.template_name).toBe("novo_modelo");
  });

  it("mudar o texto da mensagem sem mexer nos botões NÃO é barrado pela confirmação aguardando", async () => {
    const { tabelas } = montarDb({ confirmacaoPendente: true });
    const res = await PATCH(req({ name: "Só renomeei" }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.name).toBe("Só renomeei");
  });

  it("⭐ ATIVA: mover para um serviço que já tem outra ativa no mesmo momento é recusado (mandaria em dobro)", async () => {
    const { escritas } = montarDb({ outraAtiva: true });
    const res = await PATCH(req({ event_type_id: SERVICO_B }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/Corporal/);
    expect(escritas).toEqual([]);
  });

  it("PAUSADA: a mesma mudança vale — a trava só existe para quem está no ar", async () => {
    const { tabelas } = montarDb({ status: "paused", outraAtiva: true });
    const res = await PATCH(req({ event_type_id: SERVICO_B }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.event_type_id).toBe(SERVICO_B);
  });

  it("ATIVA: mover para serviço SEM outra ativa no momento é aceito", async () => {
    const { tabelas } = montarDb({ outraAtiva: false });
    const res = await PATCH(req({ event_type_id: SERVICO_B }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.event_type_id).toBe(SERVICO_B);
  });

  it("trocar para 'no dia, às 8h' limpa o número que sobrou do momento anterior", async () => {
    const { tabelas } = montarDb();
    tabelas.whatsapp_template_automations![0]!.timing_kind = "days_before";
    tabelas.whatsapp_template_automations![0]!.timing_value = 2;
    const res = await PATCH(req({ timing_kind: "day_of_8am" }), ctx());
    expect(res.status).toBe(200);
    expect(tabelas.whatsapp_template_automations![0]!.timing_value).toBeNull();
  });

  it("momento inválido (10 dias antes) é recusado", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ timing_kind: "days_before", timing_value: 10 }), ctx());
    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("⭐ as regras da criação valem aqui: modelo não aprovado é recusado", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ template_name: "reprovado", template_language: "pt_BR" }), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/não está aprovado/);
    expect(escritas).toEqual([]);
  });

  it("botão que o modelo não tem é recusado", async () => {
    const { escritas } = montarDb();
    const res = await PATCH(req({ confirm_button_text: "Botão inexistente" }), ctx());
    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("serviço de outra organização é recusado", async () => {
    const { tabelas, escritas } = montarDb();
    tabelas.calendar_event_types!.push({ id: OUTRA_AUTO, organization_id: OUTRA_ORG, is_active: true });
    const res = await PATCH(req({ event_type_id: OUTRA_AUTO }), ctx());
    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("modelo e idioma têm que mudar juntos", async () => {
    montarDb();
    expect((await PATCH(req({ template_name: "novo_modelo" }), ctx())).status).toBe(422);
  });
});
