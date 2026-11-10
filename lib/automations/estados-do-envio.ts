/**
 * Os estados de `whatsapp_template_automation_sends.status` — o MESMO conjunto
 * do CHECK do banco (migration 0221), vigiado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 *
 * Toda linha, em qualquer estado, encerra a ocorrência: o despachante nunca
 * manda duas vezes a mesma (automation_id, occurrence_key).
 *
 *   - `sending` — RESERVADA: gravada antes de chamar a Meta. A chave única faz de
 *     dois ticks simultâneos um só envio. Reserva que ficou para trás (processo
 *     morreu no meio) vira `failed` depois de `RESERVA_ABANDONADA_MIN` — sem
 *     reenviar, porque envio em dobro é pior que não-envio;
 *   - `sent` — a Meta aceitou; `external_id` é o que a resposta do paciente casa;
 *   - `failed` — a Meta recusou ou o envio quebrou; não é reenviado;
 *   - `skipped` — DISPENSADA por decisão humana (ex.: a clínica confirmou à mão
 *     quando o automático atrasou, 2026-11-10). Não é envio nem falha.
 */
export const ESTADOS_DO_ENVIO = ["sending", "sent", "failed", "skipped"] as const;
export type EstadoDoEnvio = (typeof ESTADOS_DO_ENVIO)[number];

/** Depois disto, uma reserva `sending` é tratada como interrompida. */
export const RESERVA_ABANDONADA_MIN = 10;
