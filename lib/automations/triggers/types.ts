/**
 * O ponto de extensão da família de automações (`whatsapp_template_automations
 * .trigger_kind`, vocabulário aberto). O despachante (`lib/automations/
 * dispatch.ts`) não sabe o que cada gatilho verifica — só chama `resolve` e
 * manda template pra quem voltar. A próxima automação anunciada
 * (aniversariantes) entra registrando um resolver novo em
 * `TRIGGER_RESOLVERS`, sem tocar no despachante nem no schema.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Uma ocorrência PRONTA pra virar mensagem — o gatilho já decidiu que é a vez dela. */
export interface OcorrenciaDevida {
  leadId: string | null;
  contactId: string;
  /** Nome pro slot `contact_name`/`contact_first_name`. */
  displayName: string;
  /**
   * A chave de dedup — grava em
   * `whatsapp_template_automation_sends.occurrence_key`
   * (`unique(automation_id, occurrence_key)`). Cada trigger_kind decide o
   * PRÓPRIO formato: pro lembrete de agendamento é o `activity_id` da
   * linha `meeting_scheduled`; um gatilho futuro sem linha de atividade
   * pra apontar (aniversariantes) usaria outra coisa, ex. `contact_id +
   * ano`.
   */
  occurrenceKey: string;
  /** ISO com offset — só quando o gatilho tem uma data/hora própria (agendamento). Alimenta os slots `appointment_date`/`appointment_time`. */
  appointmentAt?: string;
}

export interface AutomationForResolve {
  id: string;
  organizationId: string;
}

export interface TriggerResolver {
  /** Quem está devido AGORA — já filtrado por quem nunca recebeu esta ocorrência. */
  resolve(admin: SupabaseClient, automation: AutomationForResolve, now: Date): Promise<OcorrenciaDevida[]>;
}
