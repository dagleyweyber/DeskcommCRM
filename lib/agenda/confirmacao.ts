/**
 * Confirmação automática de agendamento (migration 0201) — o cliente toca no
 * botão do modelo ("Confirmo presença" / "Preciso remarcar") e o compromisso
 * muda de status na Agenda sozinho.
 *
 * Como a resposta acha o compromisso, sem adivinhar por texto ou por "o
 * último agendamento deste contato":
 *   resposta (webhook, `context.id` = wamid da mensagem respondida)
 *     → `whatsapp_template_automation_sends.external_id` (o envio da automação)
 *     → `appointment_id` (gravado pelo despachante no envio)
 *     → a automação diz qual botão confirma e qual desmarca.
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
  | { resultado: "atualizado"; appointmentId: string; status: DecisaoDoCliente }
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
    const c = atual as CompromissoRespondido | null;
    if (!c) return { resultado: "ignorado", motivo: "compromisso_removido" };
    if (!STATUS_QUE_ACEITAM_RESPOSTA.includes(c.status)) return { resultado: "ignorado", motivo: `status_${c.status}` };
    if (c.status === decisao) return { resultado: "ignorado", motivo: "ja_registrado" };

    const agora = p.agora ?? new Date();
    const { data: atualizado, error } = await admin
      .from("calendar_appointments")
      .update({ status: decisao, client_responded_at: agora.toISOString(), revision: c.revision + 1 })
      .eq("organization_id", p.organizationId)
      .eq("id", c.id)
      .eq("revision", c.revision)
      .select("id")
      .maybeSingle();
    if (error || !atualizado) {
      // Alguém mexeu no compromisso no mesmo instante — a mudança da pessoa vence.
      return { resultado: "ignorado", motivo: error ? `erro_${error.message}` : "alterado_em_paralelo" };
    }

    await audit({
      action: "calendar_appointment.client_responded",
      organizationId: p.organizationId,
      actorUserId: null,
      resourceType: "calendar_appointment",
      resourceId: c.id,
      metadata: { status: decisao, respondeu_a: p.respondeuA },
      requestId: `confirmacao:${p.respondeuA}`,
    });

    if (decisao === "declined") await avisaEquipe(admin, p.organizationId, c);
    // Compromisso do Belle: a recepção olha a agenda de lá, então a confirmação volta
    // para o Belle. "Preciso remarcar" não volta — não libera a vaga (ver cabeçalho).
    if (decisao === "confirmed") await devolverConfirmacaoDoCompromisso(admin, p.organizationId, c.id);

    return { resultado: "atualizado", appointmentId: c.id, status: decisao };
  } catch (err) {
    logger.error("[agenda.confirmacao] falha ao registrar resposta", {
      organization_id: p.organizationId,
      respondeu_a: p.respondeuA,
      erro: err instanceof Error ? err.message : String(err),
    });
    return { resultado: "ignorado", motivo: "erro" };
  }
}

/** Aviso na Central: o cliente disse que não vem e a vaga continua presa até alguém agir. */
async function avisaEquipe(admin: SupabaseClient, organizationId: string, c: CompromissoRespondido): Promise<void> {
  const { data: contato } = await admin
    .from("contacts")
    .select("display_name, phone_number")
    .eq("organization_id", organizationId)
    .eq("id", c.contact_id)
    .maybeSingle();
  const pessoa = contato as { display_name: string | null; phone_number: string | null } | null;
  const nome = pessoa?.display_name ?? pessoa?.phone_number ?? "Um cliente";
  const quando = new Date(c.starts_at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", "appointment_declined")
    .eq("ref_id", c.id)
    .eq("status", "open")
    .maybeSingle();
  if (jaAberto) return;

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "appointment_declined",
    severity: "warn",
    title: `${nome} não confirmou o agendamento de ${quando}`,
    body:
      "O cliente respondeu pelo WhatsApp que não vai comparecer. O horário continua reservado — " +
      "remarque ou cancele na Agenda para liberar a vaga.",
    ref_kind: "calendar_appointment",
    ref_id: c.id,
  });
  if (error) {
    logger.error("[agenda.confirmacao] aviso na Central falhou", {
      organization_id: organizationId,
      appointment_id: c.id,
      erro: error.message,
    });
  }
}
