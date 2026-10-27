/**
 * `trigger_kind = 'appointment_reminder'` — lembrete/confirmação de agendamento.
 *
 * Toda a decisão de "quem está devido AGORA" mora em SQL
 * (`fn_due_appointment_reminders`, migrations 0169 → 0199 → 0201): desde a
 * 0201 ela lê `calendar_appointments` direto — cliente sem negócio aberto
 * também recebe — e calcula o momento de envio de cada automação (no dia às
 * 8h, N dias antes às 8h, N horas antes, sempre no fuso da clínica). Este
 * arquivo só traduz a linha do banco pra `OcorrenciaDevida`.
 *
 * O limiar das 8h que vivia aqui foi para o SQL na 0201: com "N horas antes"
 * ele deixou de ser universal, e duas regras de horário em dois lugares
 * divergiriam.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AutomationForResolve, OcorrenciaDevida, TriggerResolver } from "./types";

interface LinhaDevida {
  lead_id: string | null;
  contact_id: string;
  /** Desde a 0201: o id do COMPROMISSO (nome mantido para a assinatura da função não mudar). */
  activity_id: string;
  scheduled_at: string;
  display_name: string;
}

export const resolvedorDeAgendamento: TriggerResolver = {
  async resolve(
    admin: SupabaseClient,
    automation: AutomationForResolve,
    now: Date,
  ): Promise<OcorrenciaDevida[]> {
    const { data, error } = await admin.rpc("fn_due_appointment_reminders", {
      p_organization_id: automation.organizationId,
      p_automation_id: automation.id,
      p_now: now.toISOString(),
    });
    if (error || !data) return [];

    return (data as LinhaDevida[]).map((row) => ({
      leadId: row.lead_id,
      contactId: row.contact_id,
      displayName: row.display_name,
      occurrenceKey: row.activity_id,
      appointmentAt: row.scheduled_at,
      appointmentId: row.activity_id,
    }));
  },
};
