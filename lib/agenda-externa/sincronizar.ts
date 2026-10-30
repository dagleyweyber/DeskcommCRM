/**
 * Sincronização da agenda externa (Belle → Agenda do CRM).
 *
 * ─── O ciclo ─────────────────────────────────────────────────────────────────
 * O Belle não avisa nada (sem webhook) e não responde "o que mudou desde X".
 * Então cada rodada RELÊ janelas inteiras e compara com o que o CRM já tem:
 *   - a janela PERTO (ontem → +7 dias) a toda rodada — é onde a recepção mexe;
 *   - uma fatia da janela LONGE (+8 → +60 dias) por rodada, em rodízio.
 *
 * ─── As regras ───────────────────────────────────────────────────────────────
 *  1. O Belle manda: horário, duração, sala, serviço e status vêm de lá.
 *     Exceção: a paciente respondeu à confirmação automática do CRM (0201) e o
 *     Belle ainda diz só "Marcado" — a resposta dela vale até a recepção mudar
 *     o status lá.
 *  2. Nunca duplica: índice único (org, provedor, código do Belle).
 *  3. Agendamento que some do Belle dentro da janela relida vira cancelado
 *     ("Removido do Belle") — o horário volta a ficar livre na Agenda.
 *  4. Cliente casa por celular, nas duas grafias (com e sem o nono dígito).
 *     Sem contato: cria. Não cria negócio — paciente da clínica não é card novo
 *     no Kanban.
 *  5. A PRIMEIRA importação é silenciosa: o histórico entra sem mexer na
 *     timeline nem no funil. Depois dela, agendamento novo fecha o laço como o
 *     marcado pela Agenda (timeline + etapa "agendad"), e atendido/faltou
 *     registra o resultado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fecharOLacoDoCompromisso } from "@/app/api/v1/agenda/agendamentos/_handler";
import { dataLocalDe, instanteDoMomentoLocal, somaDias } from "@/lib/agenda/fuso";
import type { Compromisso, StatusDoCompromisso } from "@/lib/agenda/tipos";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { criarClienteBelle, FalhaNoBelle, TokenBelleInvalido, type ClienteBelle } from "./belle/api";
import {
  chaveDoNome,
  catalogoPorCodigo,
  juntarAgendamentos,
  telefoneDoBelle,
  variantesDoTelefone,
  type AgendamentoImportado,
  type TipoDeServico,
} from "./belle/traduzir";

export const PROVEDOR = "belle" as const;

/** Fatias da janela longa, em dias a partir de hoje. Uma por rodada. */
export const FATIAS_LONGE: readonly [number, number][] = [
  [8, 20],
  [21, 33],
  [34, 46],
  [47, 60],
];

export interface Integracao {
  id: string;
  organization_id: string;
  credential_encrypted: string;
  external_account_id: string;
  default_area_code: string | null;
  initial_sync_done_at: string | null;
  far_window_index: number;
}

export interface Contagem {
  criados: number;
  atualizados: number;
  cancelados_por_remocao: number;
  contatos_criados: number;
  sem_telefone: number;
  salas_criadas: number;
}

export interface ResultadoDaRodada {
  ok: boolean;
  status: "healthy" | "invalid" | "error";
  erro: string | null;
  contagem: Contagem;
}

const ZERO: Contagem = {
  criados: 0,
  atualizados: 0,
  cancelados_por_remocao: 0,
  contatos_criados: 0,
  sem_telefone: 0,
  salas_criadas: 0,
};

const COLUNAS_EXISTENTE =
  "id, external_id, status, external_status, client_responded_at, starts_at, ends_at, room_id, title, notes, contact_id, revision, time_zone, cancelled_at, event_type_id, external_service_key";

interface Existente {
  id: string;
  external_id: string;
  status: StatusDoCompromisso;
  external_status: string | null;
  client_responded_at: string | null;
  starts_at: string;
  ends_at: string;
  room_id: string | null;
  title: string;
  notes: string | null;
  contact_id: string;
  revision: number;
  time_zone: string;
  cancelled_at: string | null;
  event_type_id: string | null;
  external_service_key: string | null;
}

function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

const mesmoInstante = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

/**
 * Regra 1: a resposta da paciente à confirmação do CRM vale enquanto o Belle
 * ainda estiver no "Agendado" genérico.
 */
export function statusFinal(
  doBelle: StatusDoCompromisso,
  atual: Pick<Existente, "status" | "client_responded_at"> | null,
): StatusDoCompromisso {
  if (
    atual &&
    doBelle === "pending" &&
    atual.client_responded_at &&
    (atual.status === "confirmed" || atual.status === "declined")
  ) {
    return atual.status;
  }
  return doBelle;
}

async function fusoDaClinica(admin: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await admin
    .from("calendar_settings")
    .select("default_schedule")
    .eq("organization_id", orgId)
    .maybeSingle();
  const tz = (data?.default_schedule as { timezone?: string } | null)?.timezone;
  return tz || "America/Sao_Paulo";
}

/** Sala do Belle → sala da Agenda: pelo código; senão pelo nome; senão cria. */
async function resolverSalas(
  admin: SupabaseClient,
  orgId: string,
  itens: AgendamentoImportado[],
  contagem: Contagem,
): Promise<Map<string, string>> {
  const { data } = await admin
    .from("calendar_rooms")
    .select("id, name, external_provider, external_id, position")
    .eq("organization_id", orgId);
  const salas = (data ?? []) as { id: string; name: string; external_provider: string | null; external_id: string | null; position: number }[];

  const porCodigo = new Map<string, string>();
  const porNome = new Map<string, string>();
  for (const s of salas) {
    if (s.external_provider === PROVEDOR && s.external_id) porCodigo.set(s.external_id, s.id);
    porNome.set(chaveDoNome(s.name), s.id);
  }
  let ultimaPosicao = Math.max(0, ...salas.map((s) => Number(s.position) || 0));

  // chave do item → id da sala
  const resolvidas = new Map<string, string>();
  for (const item of itens) {
    const chave = item.salaCodigo ? `c:${item.salaCodigo}` : `n:${chaveDoNome(item.salaNome)}`;
    if (resolvidas.has(chave) || !item.salaNome) continue;

    let salaId = item.salaCodigo ? porCodigo.get(item.salaCodigo) : undefined;
    if (!salaId) {
      const pelaChave = porNome.get(chaveDoNome(item.salaNome));
      if (pelaChave) {
        salaId = pelaChave;
        if (item.salaCodigo && !salas.find((s) => s.id === pelaChave)?.external_id) {
          await admin
            .from("calendar_rooms")
            .update({ external_provider: PROVEDOR, external_id: item.salaCodigo })
            .eq("organization_id", orgId)
            .eq("id", pelaChave)
            .is("external_id", null);
          porCodigo.set(item.salaCodigo, pelaChave);
        }
      }
    }
    if (!salaId && item.salaCodigo) {
      ultimaPosicao += 1000;
      const { data: criada, error } = await admin
        .from("calendar_rooms")
        .insert({
          organization_id: orgId,
          name: item.salaNome.replace(/\s+/g, " ").trim().slice(0, 60),
          position: ultimaPosicao,
          external_provider: PROVEDOR,
          external_id: item.salaCodigo,
        })
        .select("id")
        .single();
      if (!error && criada) {
        salaId = criada.id as string;
        contagem.salas_criadas += 1;
        porCodigo.set(item.salaCodigo, salaId);
        porNome.set(chaveDoNome(item.salaNome), salaId);
      }
    }
    if (salaId) resolvidas.set(chave, salaId);
  }
  return resolvidas;
}

function salaDoItem(salas: Map<string, string>, item: AgendamentoImportado): string | null {
  if (item.salaCodigo) return salas.get(`c:${item.salaCodigo}`) ?? null;
  return salas.get(`n:${chaveDoNome(item.salaNome)}`) ?? null;
}

/** Celular → contato, criando o que faltar. Lotes: a 1ª importação traz centenas. */
async function resolverContatos(
  admin: SupabaseClient,
  integ: Integracao,
  itens: AgendamentoImportado[],
  contagem: Contagem,
): Promise<Map<string, string>> {
  const orgId = integ.organization_id;
  const telefoneDoItem = new Map<string, string>(); // externalId → e164
  const todas = new Set<string>();
  for (const item of itens) {
    const e164 = telefoneDoBelle(item.cliente.celular, integ.default_area_code);
    if (!e164) continue;
    telefoneDoItem.set(item.externalId, e164);
    for (const v of variantesDoTelefone(e164)) todas.add(v);
  }

  const contatoDaVariante = new Map<string, string>();
  for (const lote of emLotes([...todas], 200)) {
    const { data } = await admin
      .from("contacts")
      .select("id, phone_number")
      .eq("organization_id", orgId)
      .is("is_merged_into", null)
      .in("phone_number", lote);
    for (const c of (data ?? []) as { id: string; phone_number: string }[]) contatoDaVariante.set(c.phone_number, c.id);
  }

  const acha = (e164: string) => variantesDoTelefone(e164).map((v) => contatoDaVariante.get(v)).find(Boolean);

  // Um contato por celular novo, mesmo que a paciente tenha vários agendamentos.
  const novos = new Map<string, { nome: string; codigo: string }>();
  for (const item of itens) {
    const e164 = telefoneDoItem.get(item.externalId);
    if (e164 && !acha(e164) && !novos.has(e164)) novos.set(e164, { nome: item.cliente.nome, codigo: item.cliente.codigo });
  }

  for (const lote of emLotes([...novos.entries()], 100)) {
    const linhas = lote.map(([e164, c]) => ({
      organization_id: orgId,
      name: c.nome || e164,
      display_name: c.nome || null,
      phone_number: e164,
      source: PROVEDOR,
      source_metadata: { belle_cliente: c.codigo || null },
    }));
    const { data, error } = await admin.from("contacts").insert(linhas).select("id, phone_number");
    if (!error) {
      for (const c of (data ?? []) as { id: string; phone_number: string }[]) contatoDaVariante.set(c.phone_number, c.id);
      contagem.contatos_criados += data?.length ?? 0;
      continue;
    }
    // Corrida (23505) ou linha problemática: um a um, reaproveitando quem já existe.
    for (const linha of linhas) {
      const { data: um, error: erroUm } = await admin.from("contacts").insert(linha).select("id").maybeSingle();
      if (!erroUm && um) {
        contatoDaVariante.set(linha.phone_number, um.id as string);
        contagem.contatos_criados += 1;
        continue;
      }
      const { data: existente } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", orgId)
        .eq("phone_number", linha.phone_number)
        .is("is_merged_into", null)
        .maybeSingle();
      if (existente) contatoDaVariante.set(linha.phone_number, existente.id as string);
    }
  }

  const contatoDoItem = new Map<string, string>();
  for (const item of itens) {
    const e164 = telefoneDoItem.get(item.externalId);
    const id = e164 ? acha(e164) : undefined;
    if (id) contatoDoItem.set(item.externalId, id);
  }
  return contatoDoItem;
}

/**
 * Tipos de serviço vistos nesta janela: o que é novo ganha linha "não ligada" (a
 * tela mostra para ligar), o que já existe só renova o nome e o `last_seen_at`.
 * A ligação (`event_type_id`) NUNCA é tocada aqui — é escolha de quem configura.
 * Devolve chave do tipo → serviço da Agenda (só os ligados).
 */
async function registrarTipos(
  admin: SupabaseClient,
  integ: Integracao,
  itens: AgendamentoImportado[],
  agora: Date,
): Promise<Map<string, string>> {
  const vistos = new Map<string, TipoDeServico>();
  for (const i of itens) if (i.tipo) vistos.set(i.tipo.chave, i.tipo);
  if (vistos.size > 0) {
    await admin.from("calendar_integration_service_links").upsert(
      [...vistos.values()].map((t) => ({
        organization_id: integ.organization_id,
        integration_id: integ.id,
        external_key: t.chave,
        external_label: t.rotulo.slice(0, 120),
        last_seen_at: agora.toISOString(),
      })),
      { onConflict: "integration_id,external_key" },
    );
  }
  const { data } = await admin
    .from("calendar_integration_service_links")
    .select("external_key, event_type_id")
    .eq("organization_id", integ.organization_id)
    .eq("integration_id", integ.id)
    .not("event_type_id", "is", null);
  const mapa = new Map<string, string>();
  for (const l of (data ?? []) as { external_key: string; event_type_id: string }[]) mapa.set(l.external_key, l.event_type_id);
  return mapa;
}

function ctxDoSistema(integ: Integracao) {
  return {
    organization_id: integ.organization_id,
    // "O produto agiu" — nem uma pessoa nem um agente de IA (ver activity-emitter).
    actor: { type: "webhook_source" as const, id: integ.id },
    requestId: `agenda-externa:${integ.id}`,
  };
}

/** Aplica uma janela relida: cria, atualiza e cancela o que sumiu. */
export async function aplicarJanela(
  admin: SupabaseClient,
  integ: Integracao,
  itens: AgendamentoImportado[],
  janela: { de: string; ate: string; timezone: string },
  opcoes: { silencioso: boolean; agora: Date; contagem: Contagem },
): Promise<void> {
  const { contagem } = opcoes;
  const orgId = integ.organization_id;

  // O que o CRM já tem: pelos códigos vistos agora (mesmo que tenham mudado de
  // dia) e pela janela (para achar o que sumiu do Belle).
  const existentes = new Map<string, Existente>();
  for (const lote of emLotes(itens.map((i) => i.externalId), 200)) {
    const { data } = await admin
      .from("calendar_appointments")
      .select(COLUNAS_EXISTENTE)
      .eq("organization_id", orgId)
      .eq("external_provider", PROVEDOR)
      .in("external_id", lote);
    for (const e of (data ?? []) as Existente[]) existentes.set(e.external_id, e);
  }
  const inicioJanela = instanteDoMomentoLocal(janela.de, "00:00", janela.timezone).toISOString();
  const fimJanela = instanteDoMomentoLocal(somaDias(janela.ate, 1), "00:00", janela.timezone).toISOString();
  const { data: naJanela } = await admin
    .from("calendar_appointments")
    .select(COLUNAS_EXISTENTE)
    .eq("organization_id", orgId)
    .eq("external_provider", PROVEDOR)
    .neq("status", "cancelled")
    .gte("starts_at", inicioJanela)
    .lt("starts_at", fimJanela);

  const salas = await resolverSalas(admin, orgId, itens, contagem);
  const servicoDoTipo = await registrarTipos(admin, integ, itens, opcoes.agora);
  // Contato só para quem ainda não está no CRM — o resto já tem `contact_id`.
  const contatos = await resolverContatos(
    admin,
    integ,
    itens.filter((i) => !existentes.has(i.externalId) && i.status !== "cancelled"),
    contagem,
  );

  const novos: Record<string, unknown>[] = [];
  for (const item of itens) {
    const atual = existentes.get(item.externalId) ?? null;
    const roomId = salaDoItem(salas, item);
    const chaveDoTipo = item.tipo?.chave ?? null;
    const eventTypeId = chaveDoTipo ? (servicoDoTipo.get(chaveDoTipo) ?? null) : null;
    const status = statusFinal(item.status, atual);

    if (!atual) {
      // Desmarcado que o CRM nunca viu não interessa: não ocupa nada.
      if (status === "cancelled") continue;
      const contactId = contatos.get(item.externalId);
      if (!contactId) {
        contagem.sem_telefone += 1;
        continue;
      }
      novos.push({
        organization_id: orgId,
        room_id: roomId,
        title: item.titulo,
        starts_at: item.startsAt,
        ends_at: item.endsAt,
        time_zone: janela.timezone,
        status,
        contact_id: contactId,
        notes: item.notas,
        source: PROVEDOR,
        external_provider: PROVEDOR,
        external_id: item.externalId,
        external_status: item.statusExterno,
        external_service_key: chaveDoTipo,
        event_type_id: eventTypeId,
      });
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (!mesmoInstante(atual.starts_at, item.startsAt)) patch.starts_at = item.startsAt;
    if (!mesmoInstante(atual.ends_at, item.endsAt)) patch.ends_at = item.endsAt;
    if (roomId && atual.room_id !== roomId) patch.room_id = roomId;
    if (atual.title !== item.titulo) patch.title = item.titulo;
    if ((atual.notes ?? null) !== item.notas) patch.notes = item.notas;
    if (atual.external_status !== item.statusExterno) patch.external_status = item.statusExterno;
    if (atual.external_service_key !== chaveDoTipo) patch.external_service_key = chaveDoTipo;
    if (atual.event_type_id !== eventTypeId) patch.event_type_id = eventTypeId;
    if (atual.status !== status) {
      patch.status = status;
      if (status === "cancelled") {
        patch.cancelled_at = opcoes.agora.toISOString();
        patch.cancellation_reason = `${item.statusExterno || "Cancelado"} no Belle`;
      } else if (atual.status === "cancelled") {
        patch.cancelled_at = null;
        patch.cancellation_reason = null;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    patch.revision = atual.revision + 1;

    const { data: atualizado, error } = await admin
      .from("calendar_appointments")
      .update(patch)
      .eq("organization_id", orgId)
      .eq("id", atual.id)
      .select("id, organization_id, event_type_id, room_id, title, description, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, cancelled_at, cancellation_reason, rescheduled_from_id, revision")
      .maybeSingle();
    if (error || !atualizado) {
      logger.warn("[agenda-externa] update falhou", { organization_id: orgId, external_id: item.externalId, erro: error?.message });
      continue;
    }
    contagem.atualizados += 1;
    if (!opcoes.silencioso && patch.status && (status === "completed" || status === "no_show")) {
      await fecharOLacoDoCompromisso(admin, ctxDoSistema(integ), atualizado as unknown as Compromisso, {
        tipo: "meeting_outcome",
        outcome: status === "completed" ? "attended" : "no_show",
      });
    }
  }

  for (const lote of emLotes(novos, 200)) {
    const { data, error } = await admin.from("calendar_appointments").insert(lote).select("id, organization_id, event_type_id, room_id, title, description, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, cancelled_at, cancellation_reason, rescheduled_from_id, revision");
    let criados = (data ?? []) as unknown as Compromisso[];
    if (error) {
      // Um código já importado por uma rodada concorrente derruba o lote: um a um.
      criados = [];
      for (const linha of lote) {
        const { data: um } = await admin.from("calendar_appointments").insert(linha).select("id, organization_id, event_type_id, room_id, title, description, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, conversation_id, location_kind, location_detail, notes, cancelled_at, cancellation_reason, rescheduled_from_id, revision").maybeSingle();
        if (um) criados.push(um as unknown as Compromisso);
      }
    }
    contagem.criados += criados.length;
    if (opcoes.silencioso) continue;
    for (const c of criados) {
      if ((c.status === "pending" || c.status === "confirmed") && new Date(c.starts_at) > opcoes.agora) {
        await fecharOLacoDoCompromisso(admin, ctxDoSistema(integ), c, { tipo: "meeting_scheduled" });
      }
    }
  }

  // Regra 3: sumiu do Belle. Relatório vazio com agendamentos no CRM é mais
  // provável ser resposta ruim do Belle do que a agenda inteira apagada — não cancela.
  if (itens.length === 0) return;
  const vistos = new Set(itens.map((i) => i.externalId));
  for (const e of (naJanela ?? []) as Existente[]) {
    if (vistos.has(e.external_id)) continue;
    const { error } = await admin
      .from("calendar_appointments")
      .update({
        status: "cancelled",
        cancelled_at: opcoes.agora.toISOString(),
        cancellation_reason: "Removido do Belle",
        revision: e.revision + 1,
      })
      .eq("organization_id", orgId)
      .eq("id", e.id)
      .eq("revision", e.revision);
    if (!error) contagem.cancelados_por_remocao += 1;
  }
}

async function lerJanela(cliente: ClienteBelle, codEstab: string, de: string, ate: string, comFinalizados: boolean) {
  const relatorio = await cliente.relatorioDeAtendimentos(codEstab, de, ate);
  const abertos = await cliente.agendamentosEmAberto(codEstab, de, ate);
  const finalizados = comFinalizados ? await cliente.agendamentosFinalizados(codEstab, de, ate) : [];
  return { relatorio, listas: [...abertos, ...finalizados] };
}

/** Uma rodada completa de uma conexão. Nunca lança: o resultado diz o que houve. */
export async function sincronizarIntegracao(
  admin: SupabaseClient,
  integ: Integracao,
  opcoes: { agora?: Date; cliente?: ClienteBelle } = {},
): Promise<ResultadoDaRodada> {
  const agora = opcoes.agora ?? new Date();
  const contagem: Contagem = { ...ZERO };
  let resultado: ResultadoDaRodada;

  try {
    let cliente = opcoes.cliente;
    if (!cliente) {
      const token = await decryptWebhookSecret(admin, integ.credential_encrypted);
      if (!token) throw new FalhaNoBelle("Não foi possível decifrar o token guardado (chave de criptografia do servidor).");
      cliente = criarClienteBelle({ token });
    }
    const timezone = await fusoDaClinica(admin, integ.organization_id);
    const hoje = dataLocalDe(agora, timezone);
    // Catálogo uma vez por rodada: é dele que sai o tipo (depilação, estética…) de cada serviço.
    const catalogo = catalogoPorCodigo(await cliente.servicos());
    const silencioso = !integ.initial_sync_done_at;
    const indice = ((integ.far_window_index % FATIAS_LONGE.length) + FATIAS_LONGE.length) % FATIAS_LONGE.length;
    const [ini, fim] = FATIAS_LONGE[indice]!;

    const janelas = [
      { de: somaDias(hoje, -1), ate: somaDias(hoje, 7), comFinalizados: true },
      { de: somaDias(hoje, ini), ate: somaDias(hoje, fim), comFinalizados: false },
    ];
    for (const j of janelas) {
      const { relatorio, listas } = await lerJanela(cliente, integ.external_account_id, j.de, j.ate, j.comFinalizados);
      const itens = juntarAgendamentos(relatorio, listas, timezone, catalogo);
      await aplicarJanela(admin, integ, itens, { de: j.de, ate: j.ate, timezone }, { silencioso, agora, contagem });
    }

    const proximoIndice = integ.far_window_index + 1;
    const patch: Record<string, unknown> = {
      status: "healthy",
      last_error: null,
      last_sync_at: agora.toISOString(),
      last_sync_stats: contagem,
      far_window_index: proximoIndice,
    };
    // A 1ª importação termina quando todas as fatias longas foram lidas uma vez.
    if (silencioso && proximoIndice >= FATIAS_LONGE.length) patch.initial_sync_done_at = agora.toISOString();
    await admin.from("calendar_integrations").update(patch).eq("id", integ.id).eq("organization_id", integ.organization_id);
    resultado = { ok: true, status: "healthy", erro: null, contagem };
  } catch (err) {
    const status = err instanceof TokenBelleInvalido ? "invalid" : "error";
    const erro =
      err instanceof TokenBelleInvalido || err instanceof FalhaNoBelle
        ? err.message
        : "Erro inesperado na sincronização.";
    logger.error("[agenda-externa] rodada falhou", {
      organization_id: integ.organization_id,
      integration_id: integ.id,
      erro: err instanceof Error ? err.message : String(err),
    });
    await admin
      .from("calendar_integrations")
      .update({ status, last_error: erro, last_sync_at: agora.toISOString(), last_sync_stats: contagem })
      .eq("id", integ.id)
      .eq("organization_id", integ.organization_id);
    resultado = { ok: false, status, erro, contagem };
  }
  return resultado;
}
