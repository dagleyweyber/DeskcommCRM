/**
 * Tipos compartilhados da Agenda (núcleo, Fase 1 — sem Google Calendar).
 *
 * Vocabulário espelhado no CHECK de `calendar_appointments`/
 * `calendar_event_types` (migration 0182) — mudar aqui sem mudar lá (ou
 * vice-versa) é exatamente o que `tests/unit/vocabulario-banco-x-typescript.test.ts`
 * existe para pegar.
 */

export const STATUS_DO_COMPROMISSO = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type StatusDoCompromisso = (typeof STATUS_DO_COMPROMISSO)[number];

/** Status que ainda OCUPAM a agenda — `pending` ocupa por design (ver lib/agenda/ocupados.ts). */
export const STATUS_QUE_OCUPAM: readonly StatusDoCompromisso[] = [
  "pending",
  "confirmed",
  "completed",
];

export const TIPO_DE_LOCAL = ["in_person", "phone", "video", "other"] as const;
export type TipoDeLocal = (typeof TIPO_DE_LOCAL)[number];

export interface TipoDeCompromisso {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  minimum_notice_minutes: number;
  booking_window_days: number;
  slot_interval_minutes: number | null;
  location_kind: TipoDeLocal;
  location_detail: string | null;
  default_owner_user_id: string | null;
  is_active: boolean;
}

export interface Compromisso {
  id: string;
  organization_id: string;
  event_type_id: string | null;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: StatusDoCompromisso;
  owner_user_id: string | null;
  contact_id: string;
  conversation_id: string | null;
  location_kind: TipoDeLocal;
  location_detail: string | null;
  notes: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  rescheduled_from_id: string | null;
  revision: number;
}

/** Um candidato de horário livre, já no formato que a grade/IA consomem. */
export interface HorarioLivre {
  starts_at: string;
  ends_at: string;
}

/** Um intervalo que OCUPA a agenda de um dono — unidade mínima do motor de disponibilidade. */
export interface IntervaloOcupado {
  starts_at: string;
  ends_at: string;
}
