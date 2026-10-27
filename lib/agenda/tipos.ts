/**
 * Tipos compartilhados da Agenda (núcleo da 0182 + agenda por sala da 0200).
 *
 * Vocabulário espelhado no CHECK de `calendar_appointments`/
 * `calendar_event_types` (migrations 0182/0200) — mudar aqui sem mudar lá (ou
 * vice-versa) é exatamente o que `tests/invariants/vocabulario-banco-x-typescript.test.ts`
 * existe para pegar.
 */

/**
 * - `pending`   — agendado, aguardando o cliente confirmar ("Agendado").
 * - `confirmed` — o CLIENTE confirmou (resposta à confirmação automática ou
 *   registro manual da recepção). Até a 0200 o app gravava isto ao criar —
 *   não é mais o caso.
 * - `declined`  — o cliente respondeu que não vem ("Não confirmado"). Continua
 *   ocupando o horário até a recepção remarcar ou cancelar.
 */
export const STATUS_DO_COMPROMISSO = [
  "pending",
  "confirmed",
  "declined",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type StatusDoCompromisso = (typeof STATUS_DO_COMPROMISSO)[number];

/**
 * Status que ainda OCUPAM a sala — o mesmo conjunto do `where` da constraint
 * de exclusão `calendar_appointments_sala_sem_sobreposicao` (migration 0200).
 */
export const STATUS_QUE_OCUPAM: readonly StatusDoCompromisso[] = [
  "pending",
  "confirmed",
  "declined",
  "completed",
];

export const RÓTULO_DO_STATUS: Record<StatusDoCompromisso, string> = {
  pending: "Agendado",
  confirmed: "Confirmado",
  declined: "Não confirmado",
  cancelled: "Cancelado",
  completed: "Compareceu",
  no_show: "Faltou",
};

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
  /** Salas onde o serviço pode ser feito — vazio = qualquer sala (`calendar_event_type_rooms`). */
  room_ids?: string[];
}

export interface Compromisso {
  id: string;
  organization_id: string;
  event_type_id: string | null;
  room_id: string | null;
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

/** Uma janela semanal de funcionamento — mesmo formato de `attendant_availability.schedule`. */
export interface JanelaSemanal {
  dow: number;
  start: string;
  end: string;
}

export interface HorarioDeFuncionamento {
  timezone: string;
  windows: JanelaSemanal[];
}

export interface Sala {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  position: number;
  /** Nulo = herda o horário padrão da clínica. */
  schedule: HorarioDeFuncionamento | null;
  is_active: boolean;
}

/** Um candidato de horário livre, já no formato que a grade/IA consomem. */
export interface HorarioLivre {
  starts_at: string;
  ends_at: string;
  /** A sala em que o horário está livre (a primeira livre, quando a consulta não fixou sala). */
  room_id: string;
  room_name: string;
}

/** Um intervalo que OCUPA uma sala — unidade mínima do motor de disponibilidade. */
export interface IntervaloOcupado {
  starts_at: string;
  ends_at: string;
}
