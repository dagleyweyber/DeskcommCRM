/**
 * Validação de entrada da Agenda (núcleo, Fase 1 — sem Google Calendar).
 * Vocabulário espelhado no CHECK de `calendar_appointments`/
 * `calendar_event_types` (migration 0182) e em `lib/agenda/tipos.ts` —
 * cobrado por `tests/unit/vocabulario-banco-x-typescript.test.ts`.
 */
import { z } from "zod";

import { TIPO_DE_LOCAL } from "@/lib/agenda/tipos";

export const createEventTypeSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug deve ser kebab-case"),
  duration_minutes: z.number().int().min(5).max(480).default(30),
  buffer_before_minutes: z.number().int().min(0).max(240).default(0),
  buffer_after_minutes: z.number().int().min(0).max(240).default(0),
  minimum_notice_minutes: z.number().int().min(0).max(43_200).default(60),
  booking_window_days: z.number().int().min(1).max(365).default(30),
  slot_interval_minutes: z.number().int().min(5).max(480).nullable().optional(),
  location_kind: z.enum(TIPO_DE_LOCAL).default("in_person"),
  location_detail: z.string().max(500).nullable().optional(),
  default_owner_user_id: z.string().uuid().nullable().optional(),
});
// `z.input`, não `z.infer` (que é `z.output`): os campos com `.default()`
// devem continuar OPCIONAIS pra quem monta o objeto antes do parse — é o
// servidor quem preenche o default, não quem chama.
export type CreateEventTypeInput = z.input<typeof createEventTypeSchema>;

export const updateEventTypeSchema = createEventTypeSchema.partial().extend({
  is_active: z.boolean().optional(),
});
export type UpdateEventTypeInput = z.infer<typeof updateEventTypeSchema>;

export const marcarAgendamentoSchema = z.object({
  event_type_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  owner_user_id: z.string().uuid().nullable().optional(),
  starts_at: z.string().datetime({ offset: true }),
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
  location_detail: z.string().max(500).nullable().optional(),
});
export type MarcarAgendamentoInput = z.infer<typeof marcarAgendamentoSchema>;

export const alterarAgendamentoSchema = z.object({
  revision: z.number().int().min(1),
  starts_at: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["confirmed", "completed", "no_show"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type AlterarAgendamentoInput = z.infer<typeof alterarAgendamentoSchema>;

export const cancelarAgendamentoSchema = z.object({
  revision: z.number().int().min(1),
  reason: z.string().min(2).max(500),
});
export type CancelarAgendamentoInput = z.infer<typeof cancelarAgendamentoSchema>;

export const horariosLivresQuerySchema = z.object({
  event_type_id: z.string().uuid(),
  owner_user_id: z.string().uuid().optional(),
});
export type HorariosLivresQuery = z.infer<typeof horariosLivresQuerySchema>;
