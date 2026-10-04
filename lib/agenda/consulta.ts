/**
 * A ponte entre banco e o motor puro de `horarios-livres.ts` — resolve tipo
 * de compromisso, jornada (`attendant_availability.schedule`), exceções e
 * ocupados, e chama o motor. `GET /api/v1/agenda/horarios-livres` e a
 * ferramenta MCP do agente chamam ESTA função, nunca o motor direto — garante
 * que os dois nunca divergem sobre o que está livre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { availabilityScheduleSchema } from "@/lib/schemas/routing";
import { horariosLivres } from "./horarios-livres";
import type { HorarioLivre, IntervaloOcupado, TipoDeCompromisso } from "./tipos";
import { STATUS_QUE_OCUPAM } from "./tipos";

export interface FiltroDeHorariosLivres {
  organizationId: string;
  eventTypeId: string;
  ownerUserId: string;
  agora: Date;
}

export class TipoDeCompromissoInvalido extends Error {}

async function buscaTipo(
  admin: SupabaseClient,
  organizationId: string,
  eventTypeId: string,
): Promise<TipoDeCompromisso> {
  const { data, error } = await admin
    .from("calendar_event_types")
    .select(
      "id, organization_id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active",
    )
    .eq("organization_id", organizationId)
    .eq("id", eventTypeId)
    .maybeSingle();
  if (error) throw new Error(`calendar_event_types_query_failed: ${error.message}`);
  if (!data || !(data as TipoDeCompromisso).is_active) throw new TipoDeCompromissoInvalido(eventTypeId);
  return data as TipoDeCompromisso;
}

async function buscaJornada(
  admin: SupabaseClient,
  organizationId: string,
  ownerUserId: string,
): Promise<{ timezone: string; windows: { dow: number; start: string; end: string }[] }> {
  const { data, error } = await admin
    .from("attendant_availability")
    .select("schedule")
    .eq("organization_id", organizationId)
    .eq("user_id", ownerUserId)
    .maybeSingle();
  if (error) throw new Error(`attendant_availability_query_failed: ${error.message}`);
  // Sem linha ainda (dono nunca configurou disponibilidade) = schedule vazio,
  // que o próprio motor trata como "sem restrição" — mesma leitura que
  // `isWithinSchedule` (lib/routing/eligibility.ts) já faz pro roteamento.
  const parsed = availabilityScheduleSchema.safeParse(data?.schedule ?? {});
  return parsed.success ? parsed.data : { timezone: "America/Sao_Paulo", windows: [] };
}

async function buscaExcecoes(
  admin: SupabaseClient,
  organizationId: string,
  ownerUserId: string,
  deData: string,
  ateData: string,
) {
  const { data, error } = await admin
    .from("calendar_availability_exceptions")
    .select("date, kind, start_time, end_time")
    .eq("organization_id", organizationId)
    .eq("user_id", ownerUserId)
    .gte("date", deData)
    .lte("date", ateData);
  if (error) throw new Error(`calendar_availability_exceptions_query_failed: ${error.message}`);
  return (data ?? []) as { date: string; kind: "available" | "unavailable"; start_time: string | null; end_time: string | null }[];
}

/** O que ocupa a agenda deste dono — Fase 1: só `calendar_appointments` vivos (ver tipos.ts). */
export async function ocupadosDoDono(
  admin: SupabaseClient,
  organizationId: string,
  ownerUserId: string,
  deInstante: string,
  ateInstante: string,
): Promise<IntervaloOcupado[]> {
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("starts_at, ends_at")
    .eq("organization_id", organizationId)
    .eq("owner_user_id", ownerUserId)
    .in("status", STATUS_QUE_OCUPAM)
    .gte("ends_at", deInstante)
    .lte("starts_at", ateInstante);
  if (error) throw new Error(`calendar_appointments_query_failed: ${error.message}`);
  return (data ?? []) as IntervaloOcupado[];
}

/** Monta os parâmetros e chama o motor puro — a função que `horarios-livres/route.ts` e o MCP chamam. */
export async function horariosLivresDaOrg(
  admin: SupabaseClient,
  filtro: FiltroDeHorariosLivres,
): Promise<{ tipo: TipoDeCompromisso; horarios: HorarioLivre[] }> {
  const tipo = await buscaTipo(admin, filtro.organizationId, filtro.eventTypeId);
  const ownerUserId = filtro.ownerUserId || tipo.default_owner_user_id;
  if (!ownerUserId) throw new Error("sem_dono: tipo de compromisso sem default_owner_user_id e nenhum informado");

  const schedule = await buscaJornada(admin, filtro.organizationId, ownerUserId);

  const deData = filtro.agora.toISOString().slice(0, 10);
  const ateData = new Date(filtro.agora.getTime() + tipo.booking_window_days * 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);

  const [excecoes, ocupados] = await Promise.all([
    buscaExcecoes(admin, filtro.organizationId, ownerUserId, deData, ateData),
    ocupadosDoDono(admin, filtro.organizationId, ownerUserId, filtro.agora.toISOString(), `${ateData}T23:59:59.999Z`),
  ]);

  const horarios = horariosLivres({
    agora: filtro.agora,
    schedule,
    excecoes,
    ocupados,
    durationMinutes: tipo.duration_minutes,
    slotIntervalMinutes: tipo.slot_interval_minutes,
    bufferBeforeMinutes: tipo.buffer_before_minutes,
    bufferAfterMinutes: tipo.buffer_after_minutes,
    minimumNoticeMinutes: tipo.minimum_notice_minutes,
    bookingWindowDays: tipo.booking_window_days,
  });

  return { tipo, horarios };
}

/** O candidato `{starts_at, ends_at}` está realmente livre agora? Mesmo motor da consulta, 1 resultado. */
export async function horarioEstaLivre(
  admin: SupabaseClient,
  filtro: FiltroDeHorariosLivres,
  startsAt: string,
): Promise<boolean> {
  const { horarios } = await horariosLivresDaOrg(admin, filtro);
  return horarios.some((h) => h.starts_at === startsAt);
}
