/**
 * Anti-banimento mínimo p/ envio AUTOMATIZADO (spec §8): janela 7h-22h,
 * limite diário da sessão, espaçamento 1.2s+jitter. O schema de warmup já
 * existe (channel_session_warmup + channel_sessions.daily_message_limit);
 * a lógica nasce aqui.
 *
 * A janela é medida no fuso de `TIMEZONE` (todo tenant desta instalação é
 * brasileiro), não mais na hora crua do servidor. Achado ao vivo pela
 * campanha em massa: o container roda em UTC, e `now.getHours()` lia 23h
 * quando eram 20h em Brasília — a janela real virava 4h-19h local, três
 * horas mais cedo do que o operador configura e três a menos à noite.
 * Janela por-org configurável (`channel_knobs.timezone`, já usado pelo
 * motor de pacing do agente em `lib/agent-engine/pacing/engine.ts`) fica
 * pra quando um tenant fora do Brasil existir — não hoje.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 22;
const TIMEZONE = "America/Sao_Paulo";

export interface ThrottleVerdict {
  allowed: boolean;
  retry_at?: string;
  reason?: string;
}

/**
 * Data/hora de parede em `TIMEZONE` — mesma decomposição de `wallClock` em
 * `pacing/engine.ts`. Exportada: `lib/automations/triggers/agendamento.ts`
 * reaproveita pra saber "já passou das 8h em São Paulo?" — mesma premissa
 * de fuso fixo, sem reimplementar a extração de hora local uma terceira vez.
 */
export function wallClock(instant: Date): { y: number; mo: number; d: number; h: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24 };
}

/**
 * Instante UTC cuja hora de parede em `TIMEZONE` é (y, mo, d, h):00 — duas
 * passadas pelo offset (correto sob DST), mesma técnica de `instantFromWall`
 * em `pacing/engine.ts`.
 */
function instantFromWall(y: number, mo: number, d: number, h: number): number {
  const alvoComoUtc = Date.UTC(y, mo - 1, d, h);
  let palpite = alvoComoUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(palpite));
    const palpiteComoUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h);
    palpite += alvoComoUtc - palpiteComoUtc;
  }
  return palpite;
}

export function withinSendWindow(now: Date = new Date()): boolean {
  const h = wallClock(now).h;
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

export function nextWindowStart(now: Date = new Date()): string {
  const w = wallClock(now);
  const add = w.h >= WINDOW_START_HOUR ? 1 : 0;
  return new Date(instantFromWall(w.y, w.mo, w.d + add, WINDOW_START_HOUR)).toISOString();
}

export async function checkDailyLimit(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ThrottleVerdict> {
  const { data: session } = await admin
    .from("channel_sessions")
    .select("daily_message_limit")
    .eq("id", channelSessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const limit = (session as { daily_message_limit?: number } | null)?.daily_message_limit ?? 300;

  const hoje = wallClock(new Date());
  const today = `${hoje.y}-${String(hoje.mo).padStart(2, "0")}-${String(hoje.d).padStart(2, "0")}`;
  const { data: warmup } = await admin
    .from("channel_session_warmup")
    .select("messages_sent")
    .eq("channel_session_id", channelSessionId)
    .eq("organization_id", organizationId)
    .eq("day", today)
    .maybeSingle();
  const sent = (warmup as { messages_sent?: number } | null)?.messages_sent ?? 0;

  if (sent >= limit) {
    // Sempre AMANHÃ, independente da hora agora — diferente de `nextWindowStart`
    // (que pode devolver "hoje" se chamado antes da janela abrir), o teto diário
    // só reseta na virada do dia local.
    const retryAt = new Date(instantFromWall(hoje.y, hoje.mo, hoje.d + 1, WINDOW_START_HOUR));
    return { allowed: false, retry_at: retryAt.toISOString(), reason: "daily_limit" };
  }
  return { allowed: true };
}

export const AUTOMATED_SEND_SPACING_MS = 1200;

/**
 * Espaçamento entre envios de CAMPANHA (disparo em massa) — o número que o
 * `CLAUDE.md` já prometia ("Campanha 1 msg/5s") desde antes de existir
 * campanha nenhuma no produto. Mais lento que `AUTOMATED_SEND_SPACING_MS`
 * de propósito: uma campanha manda a MESMA mensagem (ou quase) pra dezenas
 * de números em sequência, e é exatamente o padrão que detecção de banimento
 * mais pune — o envio automatizado de regra/IA responde a eventos
 * espalhados no tempo, campanha não.
 */
export const CAMPAIGN_SEND_SPACING_MS = 5000;

export function jitterMs(): number {
  return Math.floor(Math.random() * 801);
}
