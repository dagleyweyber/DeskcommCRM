/**
 * A ponte entre banco e o motor puro de `horarios-livres.ts` — resolve tipo
 * de compromisso, salas onde ele pode ser feito, horário de funcionamento de
 * cada sala (próprio ou o padrão da clínica), exceções e ocupados, e chama o
 * motor UMA vez por sala. `GET /api/v1/agenda/horarios-livres`, o handler de
 * marcar/remarcar e a ferramenta MCP do agente chamam ESTA função, nunca o
 * motor direto — garante que tela, servidor e IA nunca divergem sobre o que
 * está livre.
 *
 * Desde a 0200 a SALA é o recurso que o horário ocupa (pedido do dono do
 * produto); o profissional é opcional e não entra na conta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { availabilityScheduleSchema } from "@/lib/schemas/routing";
import { dataLocalDe, somaDias } from "./fuso";
import { horariosLivres, type ExcecaoDeDisponibilidade } from "./horarios-livres";
import type { HorarioDeFuncionamento, HorarioLivre, IntervaloOcupado, Sala, TipoDeCompromisso } from "./tipos";
import { STATUS_QUE_OCUPAM } from "./tipos";

/**
 * Horário de funcionamento quando a clínica ainda não salvou o seu — o mesmo
 * default da coluna `calendar_settings.default_schedule` (migration 0200).
 * Seg–sex 08–20, sáb 08–14.
 */
export const HORARIO_PADRAO_DA_CLINICA: HorarioDeFuncionamento = {
  timezone: "America/Sao_Paulo",
  windows: [
    { dow: 1, start: "08:00", end: "20:00" },
    { dow: 2, start: "08:00", end: "20:00" },
    { dow: 3, start: "08:00", end: "20:00" },
    { dow: 4, start: "08:00", end: "20:00" },
    { dow: 5, start: "08:00", end: "20:00" },
    { dow: 6, start: "08:00", end: "14:00" },
  ],
};

/**
 * Quem está pedindo horário muda a régua:
 * - `equipe` (recepção pela tela): sem antecedência mínima e até 1 ano à
 *   frente — a sessão de laser a cada 45 dias precisa caber. Pedido explícito.
 * - `ia` (agente de IA): respeita a antecedência e a janela configuradas no
 *   serviço — é a régua que a clínica definiu para o que o robô pode oferecer.
 */
export type OrigemDaConsulta = "equipe" | "ia";
const JANELA_DA_EQUIPE_DIAS = 366;

export interface FiltroDeHorariosLivres {
  organizationId: string;
  eventTypeId: string;
  /** Sala fixa; nulo/vazio = qualquer sala permitida para o serviço (a primeira livre, por ordem). */
  roomId?: string | null;
  /** "YYYY-MM-DD" no fuso da clínica — calcula só este dia. Sem ele, varre a janela inteira. */
  data?: string | null;
  agora: Date;
  origem: OrigemDaConsulta;
  /** Compromisso sendo editado — não conta como ocupado contra ele mesmo. */
  ignorarCompromissoId?: string | null;
}

export class TipoDeCompromissoInvalido extends Error {}
export class SalaInvalida extends Error {}

const COLUNAS_DO_TIPO =
  "id, organization_id, name, slug, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, slot_interval_minutes, location_kind, location_detail, default_owner_user_id, is_active";

async function buscaTipo(admin: SupabaseClient, organizationId: string, eventTypeId: string): Promise<TipoDeCompromisso> {
  const { data, error } = await admin
    .from("calendar_event_types")
    .select(COLUNAS_DO_TIPO)
    .eq("organization_id", organizationId)
    .eq("id", eventTypeId)
    .maybeSingle();
  if (error) throw new Error(`calendar_event_types_query_failed: ${error.message}`);
  if (!data || !(data as TipoDeCompromisso).is_active) throw new TipoDeCompromissoInvalido(eventTypeId);
  return data as TipoDeCompromisso;
}

/** Converte o jsonb do banco em horário válido — inválido vira `null` (quem chama decide o fallback). */
export function lerHorario(raw: unknown): HorarioDeFuncionamento | null {
  if (raw === null || raw === undefined) return null;
  const parsed = availabilityScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** O horário padrão da clínica (`calendar_settings`), ou o default quando ainda não salvou. */
export async function horarioPadraoDaClinica(
  admin: SupabaseClient,
  organizationId: string,
): Promise<HorarioDeFuncionamento> {
  const { data, error } = await admin
    .from("calendar_settings")
    .select("default_schedule")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`calendar_settings_query_failed: ${error.message}`);
  return lerHorario((data as { default_schedule?: unknown } | null)?.default_schedule) ?? HORARIO_PADRAO_DA_CLINICA;
}

/** Salas ATIVAS da organização, em ordem de exibição. */
export async function salasAtivas(admin: SupabaseClient, organizationId: string): Promise<Sala[]> {
  const { data, error } = await admin
    .from("calendar_rooms")
    .select("id, organization_id, name, color, position, schedule, is_active")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`calendar_rooms_query_failed: ${error.message}`);
  return ((data ?? []) as Sala[]).map((s) => ({ ...s, schedule: lerHorario(s.schedule) }));
}

/** Salas onde ESTE serviço pode ser feito — nenhuma restrição cadastrada = todas as ativas. */
export async function salasDoTipo(
  admin: SupabaseClient,
  organizationId: string,
  eventTypeId: string,
): Promise<Sala[]> {
  const [salas, vinculos] = await Promise.all([
    salasAtivas(admin, organizationId),
    admin
      .from("calendar_event_type_rooms")
      .select("room_id")
      .eq("organization_id", organizationId)
      .eq("event_type_id", eventTypeId),
  ]);
  if (vinculos.error) throw new Error(`calendar_event_type_rooms_query_failed: ${vinculos.error.message}`);
  const permitidas = new Set(((vinculos.data ?? []) as { room_id: string }[]).map((v) => v.room_id));
  if (permitidas.size === 0) return salas;
  return salas.filter((s) => permitidas.has(s.id));
}

interface ExcecaoDoBanco extends ExcecaoDeDisponibilidade {
  room_id: string | null;
  user_id: string | null;
}

async function buscaExcecoes(
  admin: SupabaseClient,
  organizationId: string,
  deData: string,
  ateData: string,
): Promise<ExcecaoDoBanco[]> {
  const { data, error } = await admin
    .from("calendar_availability_exceptions")
    .select("date, kind, start_time, end_time, room_id, user_id")
    .eq("organization_id", organizationId)
    .gte("date", deData)
    .lte("date", ateData);
  if (error) throw new Error(`calendar_availability_exceptions_query_failed: ${error.message}`);
  // Exceção de PESSOA (user_id) não afeta sala — o profissional não trava horário desde a 0200.
  return ((data ?? []) as ExcecaoDoBanco[]).filter((e) => e.room_id !== null || e.user_id === null);
}

interface OcupadoDaSala extends IntervaloOcupado {
  id: string;
  room_id: string;
}

/** O que ocupa as salas dadas no intervalo — só status que ocupam (ver `STATUS_QUE_OCUPAM`). */
export async function ocupadosDasSalas(
  admin: SupabaseClient,
  organizationId: string,
  roomIds: string[],
  deInstante: string,
  ateInstante: string,
): Promise<OcupadoDaSala[]> {
  if (roomIds.length === 0) return [];
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("id, room_id, starts_at, ends_at")
    .eq("organization_id", organizationId)
    .in("room_id", roomIds)
    .in("status", STATUS_QUE_OCUPAM)
    .gte("ends_at", deInstante)
    .lte("starts_at", ateInstante);
  if (error) throw new Error(`calendar_appointments_query_failed: ${error.message}`);
  return (data ?? []) as OcupadoDaSala[];
}

/** Monta os parâmetros e chama o motor puro por sala — a função que a rota, o handler e o MCP chamam. */
export async function horariosLivresDaOrg(
  admin: SupabaseClient,
  filtro: FiltroDeHorariosLivres,
): Promise<{ tipo: TipoDeCompromisso; salas: Sala[]; horarios: HorarioLivre[] }> {
  const tipo = await buscaTipo(admin, filtro.organizationId, filtro.eventTypeId);
  const [permitidas, padrao] = await Promise.all([
    salasDoTipo(admin, filtro.organizationId, filtro.eventTypeId),
    horarioPadraoDaClinica(admin, filtro.organizationId),
  ]);

  let salas = permitidas;
  if (filtro.roomId) {
    salas = permitidas.filter((s) => s.id === filtro.roomId);
    if (salas.length === 0) throw new SalaInvalida(filtro.roomId);
  }
  if (salas.length === 0) return { tipo, salas, horarios: [] };

  const timezone = padrao.timezone || "America/Sao_Paulo";
  const daEquipe = filtro.origem === "equipe";
  const janelaDias = daEquipe ? Math.max(tipo.booking_window_days, JANELA_DA_EQUIPE_DIAS) : tipo.booking_window_days;
  const antecedencia = daEquipe ? 0 : tipo.minimum_notice_minutes;

  const hoje = dataLocalDe(filtro.agora, timezone);
  const deData = filtro.data ?? hoje;
  const ateData = filtro.data ?? somaDias(hoje, janelaDias);

  // Folga de 1 dia nas pontas: a data civil no fuso da clínica não coincide
  // com o dia UTC, e buffer pode encostar no dia vizinho.
  const deInstante = new Date(`${somaDias(deData, -1)}T00:00:00Z`).toISOString();
  const ateInstante = new Date(`${somaDias(ateData, 2)}T00:00:00Z`).toISOString();

  const [excecoes, ocupados] = await Promise.all([
    buscaExcecoes(admin, filtro.organizationId, deData, ateData),
    ocupadosDasSalas(
      admin,
      filtro.organizationId,
      salas.map((s) => s.id),
      deInstante,
      ateInstante,
    ),
  ]);

  const porInicio = new Map<string, HorarioLivre>();
  for (const sala of salas) {
    const schedule = sala.schedule ?? padrao;
    const livres = horariosLivres({
      agora: filtro.agora,
      schedule: { timezone, windows: schedule.windows },
      excecoes: excecoes.filter((e) => e.room_id === sala.id || (e.room_id === null && e.user_id === null)),
      ocupados: ocupados.filter((o) => o.room_id === sala.id && o.id !== filtro.ignorarCompromissoId),
      durationMinutes: tipo.duration_minutes,
      slotIntervalMinutes: tipo.slot_interval_minutes,
      bufferBeforeMinutes: tipo.buffer_before_minutes,
      bufferAfterMinutes: tipo.buffer_after_minutes,
      minimumNoticeMinutes: antecedencia,
      bookingWindowDays: janelaDias,
      apenasData: filtro.data ?? undefined,
    });
    // Salas já vêm em ordem de exibição: o primeiro a ocupar o instante vence —
    // "qualquer sala" oferece a primeira livre, previsível para a recepção.
    for (const h of livres) {
      if (!porInicio.has(h.starts_at)) {
        porInicio.set(h.starts_at, { ...h, room_id: sala.id, room_name: sala.name });
      }
    }
  }

  const horarios = [...porInicio.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 200);
  return { tipo, salas, horarios };
}

/**
 * O horário `startsAt` está realmente livre AGORA? Devolve o candidato (com a
 * sala escolhida) ou `null`. Mesmo motor da consulta, restrito ao dia do
 * horário — nunca confia no que o cliente mandou de volta.
 */
export async function horarioEstaLivre(
  admin: SupabaseClient,
  filtro: Omit<FiltroDeHorariosLivres, "data">,
  startsAt: string,
): Promise<HorarioLivre | null> {
  const padrao = await horarioPadraoDaClinica(admin, filtro.organizationId);
  const data = dataLocalDe(new Date(startsAt), padrao.timezone || "America/Sao_Paulo");
  const { horarios } = await horariosLivresDaOrg(admin, { ...filtro, data });
  const alvo = new Date(startsAt).toISOString();
  return horarios.find((h) => h.starts_at === alvo) ?? null;
}
