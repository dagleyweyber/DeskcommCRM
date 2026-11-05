/**
 * Confirmação automática de agendamento (migration 0201) — o cliente toca no
 * botão do modelo ("Confirmo presença" / "Preciso remarcar") e o compromisso
 * muda de status na Agenda sozinho.
 *
 * Como a resposta acha o compromisso, sem adivinhar por texto ou por "o
 * último agendamento deste contato":
 *   resposta (webhook, `context.id` = wamid da mensagem respondida)
 *     → `whatsapp_template_automation_sends.external_id` (o envio da automação)
 *     → `appointment_id` (gravado pelo despachante no envio: o LÍDER do dia)
 *     → `fn_grupo_do_agendamento` (todos os agendamentos do paciente no dia)
 *     → a automação diz qual botão confirma e qual desmarca.
 *
 * ─── Um aviso por paciente e dia (migration 0211) ───────────────────────────
 * O Belle sobe o pacote como 2–7 agendamentos no mesmo dia, e o paciente recebe
 * UMA mensagem (a do líder, com o horário de chegada). A resposta dele vale
 * para o DIA: "Confirmar" confirma todos, "Preciso remarcar" desmarca todos e
 * abre UM aviso na Central. Quem é o grupo é decidido no banco, pela mesma
 * função que escolheu quem recebe a mensagem — duas cópias da regra divergiriam.
 *
 * Só BOTÃO conta. Texto livre ("sim", "pode ser") vai para o inbox como
 * sempre e a equipe decide — interpretar texto erraria exatamente no caso que
 * importa ("sim, mas preciso remarcar").
 *
 * "Não confirmado" NÃO libera o horário (decisão do dono do produto): um
 * clique errado do cliente não pode perder a vaga. A equipe recebe um aviso
 * na Central para remarcar ou cancelar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { devolverConfirmacaoDoCompromisso } from "@/lib/agenda-externa/devolver-confirmacao";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

import { classificaResposta, type DecisaoDoCliente } from "./botoes";
import type { StatusDoCompromisso } from "./tipos";

export type { DecisaoDoCliente } from "./botoes";

/** Status que ainda aceitam a resposta do cliente — compareceu/faltou/cancelou já encerrou o assunto. */
const STATUS_QUE_ACEITAM_RESPOSTA: readonly StatusDoCompromisso[] = ["pending", "confirmed", "declined"];

export type ResultadoDaResposta =
  | { resultado: "atualizado"; appointmentId: string; status: DecisaoDoCliente; agendamentos: number }
  | { resultado: "ignorado"; motivo: string };

interface EnvioRespondido {
  automation_id: string;
  appointment_id: string | null;
}

interface CompromissoRespondido {
  id: string;
  status: StatusDoCompromisso;
  starts_at: string;
  revision: number;
  contact_id: string;
}

interface MembroDoGrupo {
  id: string;
  starts_at: string;
  status: StatusDoCompromisso;
}

/**
 * Os agendamentos do mesmo aviso (paciente + dia + escopo da automação), via
 * `fn_grupo_do_agendamento`. Falha ou resposta vazia (banco sem a 0211) devolve
 * `[]`, e quem chama cai no comportamento de um compromisso só — o de antes.
 */
async function grupoDoAgendamento(
  admin: SupabaseClient,
  organizationId: string,
  automationId: string,
  appointmentId: string,
): Promise<MembroDoGrupo[]> {
  const { data, error } = await admin.rpc("fn_grupo_do_agendamento", {
    p_organization_id: organizationId,
    p_automation_id: automationId,
    p_appointment_id: appointmentId,
  });
  if (error || !Array.isArray(data)) return [];
  return data as MembroDoGrupo[];
}

/** Muda o status de UM compromisso com a trava otimista de `revision`. `false` = alguém mexeu junto. */
async function atualizaStatus(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  status: DecisaoDoCliente,
  agora: Date,
): Promise<boolean> {
  const { data: atual } = await admin
    .from("calendar_appointments")
    .select("revision")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  const revision = (atual as { revision: number } | null)?.revision;
  if (revision === undefined) return false;

  const { data: atualizado, error } = await admin
    .from("calendar_appointments")
    .update({ status, client_responded_at: agora.toISOString(), revision: revision + 1 })
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("revision", revision)
    .select("id")
    .maybeSingle();
  return !error && Boolean(atualizado);
}

/**
 * Registra a resposta do cliente ao botão da confirmação. Idempotente: a Meta
 * re-entrega webhook, e responder duas vezes o mesmo botão não muda nada.
 * Nunca lança — a mensagem já foi gravada no inbox; isto é efeito colateral.
 */
export async function registrarRespostaDeConfirmacao(
  admin: SupabaseClient,
  p: {
    organizationId: string;
    /** `context.id` da mensagem do cliente — o wamid do modelo que ele respondeu. */
    respondeuA: string;
    texto: string | null;
    payload: string | null;
    agora?: Date;
  },
): Promise<ResultadoDaResposta> {
  try {
    const { data: envio } = await admin
      .from("whatsapp_template_automation_sends")
      .select("automation_id, appointment_id")
      .eq("organization_id", p.organizationId)
      .eq("external_id", p.respondeuA)
      .maybeSingle();
    const e = envio as EnvioRespondido | null;
    if (!e?.appointment_id) return { resultado: "ignorado", motivo: "nao_e_resposta_de_confirmacao" };

    const { data: automacao } = await admin
      .from("whatsapp_template_automations")
      .select("confirm_button_text, decline_button_text")
      .eq("organization_id", p.organizationId)
      .eq("id", e.automation_id)
      .maybeSingle();
    if (!automacao) return { resultado: "ignorado", motivo: "automacao_removida" };

    const decisao = classificaResposta(
      { texto: p.texto, payload: p.payload },
      automacao as { confirm_button_text: string | null; decline_button_text: string | null },
    );
    if (!decisao) return { resultado: "ignorado", motivo: "botao_sem_significado" };

    const { data: atual } = await admin
      .from("calendar_appointments")
      .select("id, status, starts_at, revision, contact_id")
      .eq("organization_id", p.organizationId)
      .eq("id", e.appointment_id)
      .maybeSingle();
    const lider = atual as CompromissoRespondido | null;
    if (!lider) return { resultado: "ignorado", motivo: "compromisso_removido" };
    if (!STATUS_QUE_ACEITAM_RESPOSTA.includes(lider.status)) return { resultado: "ignorado", motivo: `status_${lider.status}` };

    // O DIA do paciente: o líder e os irmãos ainda em aberto. Sem grupo (função
    // ausente ou falha), é só o líder.
    const grupo = await grupoDoAgendamento(admin, p.organizationId, e.automation_id, lider.id);
    const membros: MembroDoGrupo[] = grupo.some((m) => m.id === lider.id)
      ? grupo
      : [{ id: lider.id, starts_at: lider.starts_at, status: lider.status }, ...grupo];
    const emAberto = membros.filter((m) => STATUS_QUE_ACEITAM_RESPOSTA.includes(m.status));
    const alvos = emAberto.filter((m) => m.status !== decisao);
    if (alvos.length === 0) return { resultado: "ignorado", motivo: "ja_registrado" };

    const agora = p.agora ?? new Date();
    const atualizados: MembroDoGrupo[] = [];
    for (const alvo of alvos) {
      // Alguém mexeu no compromisso no mesmo instante — a mudança da pessoa vence.
      if (await atualizaStatus(admin, p.organizationId, alvo.id, decisao, agora)) atualizados.push(alvo);
    }
    if (atualizados.length === 0) return { resultado: "ignorado", motivo: "alterado_em_paralelo" };

    for (const m of atualizados) {
      await audit({
        action: "calendar_appointment.client_responded",
        organizationId: p.organizationId,
        actorUserId: null,
        resourceType: "calendar_appointment",
        resourceId: m.id,
        metadata: { status: decisao, respondeu_a: p.respondeuA, agendamentos_do_dia: emAberto.length },
        requestId: `confirmacao:${p.respondeuA}`,
      });
    }

    if (decisao === "declined") {
      await avisaEquipe(admin, p.organizationId, lider, emAberto.map((m) => m.starts_at));
    }
    // Compromisso do Belle: a recepção olha a agenda de lá, então a confirmação volta
    // para o Belle, agendamento por agendamento. "Preciso remarcar" não volta — não
    // libera a vaga (ver cabeçalho).
    if (decisao === "confirmed") {
      for (const m of atualizados) await devolverConfirmacaoDoCompromisso(admin, p.organizationId, m.id);
    }

    return { resultado: "atualizado", appointmentId: lider.id, status: decisao, agendamentos: atualizados.length };
  } catch (err) {
    logger.error("[agenda.confirmacao] falha ao registrar resposta", {
      organization_id: p.organizationId,
      respondeu_a: p.respondeuA,
      erro: err instanceof Error ? err.message : String(err),
    });
    return { resultado: "ignorado", motivo: "erro" };
  }
}

const FUSO_DO_AVISO = "America/Sao_Paulo";

/** "08:20, 08:50 e 09:20" — os horários de início, em ordem, sem repetir. */
export function horariosPorExtenso(inicios: string[]): string {
  const horas = [
    ...new Set(
      [...inicios]
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
        .map((iso) =>
          new Date(iso).toLocaleTimeString("pt-BR", { timeZone: FUSO_DO_AVISO, hour: "2-digit", minute: "2-digit" }),
        ),
    ),
  ];
  if (horas.length <= 1) return horas[0] ?? "";
  return `${horas.slice(0, -1).join(", ")} e ${horas[horas.length - 1]}`;
}

/** Aviso na Central: o cliente disse que não vem e a vaga continua presa até alguém agir. UM por dia do paciente. */
async function avisaEquipe(
  admin: SupabaseClient,
  organizationId: string,
  lider: CompromissoRespondido,
  inicios: string[],
): Promise<void> {
  const { data: contato } = await admin
    .from("contacts")
    .select("display_name, phone_number")
    .eq("organization_id", organizationId)
    .eq("id", lider.contact_id)
    .maybeSingle();
  const pessoa = contato as { display_name: string | null; phone_number: string | null } | null;
  const nome = pessoa?.display_name ?? pessoa?.phone_number ?? "Um cliente";
  const dia = new Date(lider.starts_at).toLocaleDateString("pt-BR", {
    timeZone: FUSO_DO_AVISO,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  const varios = inicios.length > 1;
  const titulo = varios
    ? `${nome} não confirmou os ${inicios.length} agendamentos de ${dia} (${horariosPorExtenso(inicios)})`
    : `${nome} não confirmou o agendamento de ${dia} às ${horariosPorExtenso(inicios)}`;

  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", "appointment_declined")
    .eq("ref_id", lider.id)
    .eq("status", "open")
    .maybeSingle();
  if (jaAberto) return;

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "appointment_declined",
    severity: "warn",
    title: titulo,
    body:
      "O cliente respondeu pelo WhatsApp que precisa remarcar. " +
      (varios ? "Todos os horários do dia ficaram como não confirmados e continuam reservados — " : "O horário continua reservado — ") +
      "remarque ou cancele na Agenda para liberar a vaga.",
    ref_kind: "calendar_appointment",
    ref_id: lider.id,
  });
  if (error) {
    logger.error("[agenda.confirmacao] aviso na Central falhou", {
      organization_id: organizationId,
      appointment_id: lider.id,
      erro: error.message,
    });
  }
}
