/**
 * O registro de todo `trigger_kind` conhecido. Uma automação futura
 * (aniversariantes) entra aqui — uma linha nova, resolver próprio — sem
 * tocar em `lib/automations/dispatch.ts` nem no schema.
 */
import { resolvedorDeAgendamento } from "./agendamento";
import type { TriggerResolver } from "./types";

export const TRIGGER_RESOLVERS: Record<string, TriggerResolver> = {
  appointment_reminder: resolvedorDeAgendamento,
};

export type { AutomationForResolve, OcorrenciaDevida, TriggerResolver } from "./types";
