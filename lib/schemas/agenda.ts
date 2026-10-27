/**
 * Validação de entrada da Agenda (núcleo da 0182 + agenda por sala da 0200).
 * Vocabulário espelhado no CHECK de `calendar_appointments`/
 * `calendar_event_types` (migrations 0182/0200) e em `lib/agenda/tipos.ts` —
 * cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 */
import { z } from "zod";

import { TIPO_DE_LOCAL } from "@/lib/agenda/tipos";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

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
  /** Salas onde o serviço pode ser feito — vazio/ausente = qualquer sala. */
  room_ids: z.array(z.string().uuid()).max(100).optional(),
});
// `z.input`, não `z.infer` (que é `z.output`): os campos com `.default()`
// devem continuar OPCIONAIS pra quem monta o objeto antes do parse — é o
// servidor quem preenche o default, não quem chama.
export type CreateEventTypeInput = z.input<typeof createEventTypeSchema>;

export const updateEventTypeSchema = createEventTypeSchema
  .omit({ slug: true })
  .partial()
  .extend({
    is_active: z.boolean().optional(),
  });
export type UpdateEventTypeInput = z.infer<typeof updateEventTypeSchema>;

// ---------------------------------------------------------------------------
// Salas e horário da clínica (migration 0200)
// ---------------------------------------------------------------------------

export const createSalaSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().max(20).nullable().optional(),
  /** Nulo/ausente = herda o horário padrão da clínica. */
  schedule: availabilityScheduleSchema.nullable().optional(),
});
export type CreateSalaInput = z.input<typeof createSalaSchema>;

export const updateSalaSchema = createSalaSchema.partial().extend({
  position: z.number().finite().optional(),
  is_active: z.boolean().optional(),
});
export type UpdateSalaInput = z.input<typeof updateSalaSchema>;

export const configuracaoDaAgendaSchema = z.object({
  default_schedule: availabilityScheduleSchema,
});
export type ConfiguracaoDaAgendaInput = z.input<typeof configuracaoDaAgendaSchema>;

export const createBloqueioSchema = z
  .object({
    /** Nulo = vale para a clínica inteira (feriado). */
    room_id: z.string().uuid().nullable(),
    date: z.string().regex(DATA_CIVIL),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    reason: z.string().max(200).nullable().optional(),
  })
  .refine((b) => (b.start_time ? Boolean(b.end_time) && b.end_time! > b.start_time : !b.end_time), {
    message: "Informe início e fim (fim depois do início), ou nenhum dos dois para o dia inteiro.",
  });
export type CreateBloqueioInput = z.input<typeof createBloqueioSchema>;

// ---------------------------------------------------------------------------
// Compromissos
// ---------------------------------------------------------------------------

export const marcarAgendamentoSchema = z.object({
  event_type_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  /** Sala fixa; nulo/ausente = a primeira sala livre permitida para o serviço. */
  room_id: z.string().uuid().nullable().optional(),
  /** Profissional — opcional e informativo (não trava horário desde a 0200). */
  owner_user_id: z.string().uuid().nullable().optional(),
  starts_at: z.string().datetime({ offset: true }),
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
  location_detail: z.string().max(500).nullable().optional(),
});
export type MarcarAgendamentoInput = z.infer<typeof marcarAgendamentoSchema>;

/** Status que uma pessoa (ou a IA) pode gravar à mão — `cancelled` tem rota própria (DELETE, com motivo). */
export const STATUS_EDITAVEIS = ["pending", "confirmed", "declined", "completed", "no_show"] as const;

export const alterarAgendamentoSchema = z.object({
  revision: z.number().int().min(1),
  /** Muda dia/hora = REMARCA (novo compromisso, o antigo fica no histórico). */
  starts_at: z.string().datetime({ offset: true }).optional(),
  /** Muda o serviço = também remarca (muda a duração). */
  event_type_id: z.string().uuid().optional(),
  room_id: z.string().uuid().nullable().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  status: z.enum(STATUS_EDITAVEIS).optional(),
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
  room_id: z.string().uuid().optional(),
  data: z.string().regex(DATA_CIVIL).optional(),
  /** Compromisso sendo editado — não conta como ocupado contra ele mesmo. */
  ignorar_id: z.string().uuid().optional(),
});
export type HorariosLivresQuery = z.infer<typeof horariosLivresQuerySchema>;
