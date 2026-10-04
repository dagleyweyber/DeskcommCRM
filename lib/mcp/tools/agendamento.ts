/**
 * Ferramentas MCP da Agenda (núcleo, Fase 1 — sem Google Calendar).
 *
 * Chamam os MESMOS `lib/agenda/consulta.ts`/`app/api/v1/agenda/agendamentos/
 * _handler.ts` que a tela usa — o agente nunca pode oferecer ou marcar um
 * horário que a grade não mostraria. `horariosLivresDaOrg` é quem decide o
 * que está livre; esta camada só traduz pro formato de ferramenta.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { TipoDeCompromissoInvalido, horariosLivresDaOrg } from "@/lib/agenda/consulta";
import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import { ApiError } from "@/lib/api/types";

const listarTiposShape = {};

export const crmListEventTypes: McpToolDefinition<typeof listarTiposShape> = {
  name: "crm_list_event_types",
  description:
    "Lista os tipos de compromisso configurados nesta organização (ex.: 'Avaliação', 'Consulta de retorno'), com duração e id — use o id em crm_get_available_slots/crm_book_appointment.",
  inputSchema: listarTiposShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("calendar_event_types")
      .select("id, name, duration_minutes, default_owner_user_id")
      .eq("organization_id", ctx.organizationId)
      .eq("is_active", true)
      .order("position", { ascending: true });
    if (error) throw new Error(`calendar_event_types_query_failed: ${error.message}`);
    return { event_types: data ?? [] };
  },
};

const horariosShape = {
  event_type_id: z.string().uuid().describe("Id do tipo de compromisso (ver crm_list_event_types)."),
  owner_user_id: z
    .string()
    .uuid()
    .optional()
    .describe("Dono da agenda — opcional se o tipo já tem um padrão."),
};

export const crmGetAvailableSlots: McpToolDefinition<typeof horariosShape> = {
  name: "crm_get_available_slots",
  description:
    "Lista horários realmente livres pra marcar — o MESMO cálculo que a tela usa. NUNCA invente um horário fora desta lista.",
  inputSchema: horariosShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    try {
      const { horarios } = await horariosLivresDaOrg(ctx.supabase, {
        organizationId: ctx.organizationId,
        eventTypeId: input.event_type_id,
        ownerUserId: input.owner_user_id ?? "",
        agora: new Date(),
      });
      return { slots: horarios };
    } catch (err) {
      if (err instanceof TipoDeCompromissoInvalido) {
        throw new Error("Tipo de compromisso inválido ou inativo.");
      }
      throw err;
    }
  },
};

const marcarShape = {
  event_type_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  starts_at: z
    .string()
    .datetime({ offset: true })
    .describe("Instante ISO 8601 — DEVE ser um dos valores devolvidos por crm_get_available_slots."),
  owner_user_id: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
};

export const crmBookAppointment: McpToolDefinition<typeof marcarShape> = {
  name: "crm_book_appointment",
  description:
    "Marca um compromisso com um contato. O horário é reconferido contra a agenda real no servidor — não confia no que você leu antes, então chame crm_get_available_slots de novo se o tempo passou entre ler e marcar.",
  inputSchema: marcarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const compromisso = await marcarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          event_type_id: input.event_type_id,
          contact_id: input.contact_id,
          starts_at: input.starts_at,
          owner_user_id: input.owner_user_id ?? null,
          notes: input.notes ?? null,
        },
      );
      return { appointment_id: compromisso.id, starts_at: compromisso.starts_at, status: compromisso.status };
    } catch (err) {
      if (err instanceof ApiError) throw new Error(err.message);
      throw err;
    }
  },
};

const remarcarShape = {
  appointment_id: z.string().uuid(),
  revision: z.number().int().min(1).describe("Valor de `revision` lido na última leitura do compromisso — evita remarcar em cima de uma mudança que você não viu."),
  starts_at: z.string().datetime({ offset: true }).describe("Novo instante — DEVE vir de crm_get_available_slots."),
};

export const crmRescheduleAppointment: McpToolDefinition<typeof remarcarShape> = {
  name: "crm_reschedule_appointment",
  description: "Remarca um compromisso existente pra um novo horário livre. O compromisso antigo fica no histórico.",
  inputSchema: remarcarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const compromisso = await alterarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        input.appointment_id,
        { revision: input.revision, starts_at: input.starts_at },
      );
      return { appointment_id: compromisso.id, starts_at: compromisso.starts_at, status: compromisso.status };
    } catch (err) {
      if (err instanceof ApiError) throw new Error(err.message);
      throw err;
    }
  },
};

const cancelarShape = {
  appointment_id: z.string().uuid(),
  revision: z.number().int().min(1),
  reason: z.string().min(2).max(500).describe("Motivo do cancelamento — aparece no histórico do compromisso."),
};

export const crmCancelAppointment: McpToolDefinition<typeof cancelarShape> = {
  name: "crm_cancel_appointment",
  description:
    "Cancela um compromisso. IRREVERSÍVEL — o horário volta pra disponibilidade imediatamente. Confirme com a pessoa antes de usar esta ferramenta.",
  inputSchema: cancelarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const compromisso = await cancelarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        input.appointment_id,
        { revision: input.revision, reason: input.reason },
      );
      return { appointment_id: compromisso.id, status: compromisso.status };
    } catch (err) {
      if (err instanceof ApiError) throw new Error(err.message);
      throw err;
    }
  },
};
