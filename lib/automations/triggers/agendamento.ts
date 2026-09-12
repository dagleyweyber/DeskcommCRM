/**
 * `trigger_kind = 'appointment_reminder'` — lembrete de agendamento.
 *
 * Toda a busca de "quem tem agendamento hoje, ainda sem lembrete desta
 * automação" mora em SQL (`fn_due_appointment_reminders`, migration
 * 0169) — `scheduled_at` vive dentro de `payload` jsonb da linha
 * `meeting_scheduled` mais recente do lead, e achar isso por
 * encadeamento `.from().select()` do Supabase JS exigiria `DISTINCT ON`
 * que o cliente não expressa. Este arquivo só filtra o limiar de horário
 * e traduz a linha do banco pra `OcorrenciaDevida`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { wallClock } from "@/lib/automation/throttle";
import type { AutomationForResolve, OcorrenciaDevida, TriggerResolver } from "./types";

/** Nada dispara antes disso, hora de parede em América/São_Paulo — pedido explícito: "às 8h da manhã". */
const HORA_DE_ENVIO = 8;

interface LinhaDevida {
  lead_id: string;
  contact_id: string;
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
    // Antes das 8h (parede de SP), nada está devido — não importa o que o
    // banco devolveria. O cron roda a cada 15min o dia inteiro; é este
    // limiar que decide quando a ocorrência vira "hora de mandar".
    if (wallClock(now).h < HORA_DE_ENVIO) return [];

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
    }));
  },
};
