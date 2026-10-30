/**
 * Fase 2 do Belle: a confirmação que o CLIENTE deu pelo botão do WhatsApp volta
 * para o Belle, para a recepção ver "Confirmado" na agenda que ela usa.
 *
 * ─── Por que não há fila nem coluna nova ─────────────────────────────────────
 * O que precisa ser devolvido já se descreve pelo próprio dado: compromisso do
 * Belle, `confirmed` por resposta do cliente (`client_responded_at`), e o Belle
 * ainda dizendo "Marcado". Quando o Belle passa a dizer "Confirmado" a condição
 * deixa de valer sozinha. Então a mesma função serve a dois momentos:
 *   - na hora da resposta (um compromisso só) — a recepção vê em segundos;
 *   - a cada rodada do sincronizador (todos os pendentes) — se o Belle estava
 *     fora do ar, ou se o compromisso é de antes desta fase, ele se corrige.
 *
 * ─── O que NÃO devolve ───────────────────────────────────────────────────────
 * "Preciso remarcar": pela decisão do produto ele não libera a vaga (um clique
 * errado não pode perder o horário) e escrever "Desmarcado" no Belle liberaria.
 * A equipe é avisada na Central e decide lá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { criarClienteBelle, FalhaNoBelle, TokenBelleInvalido, type ClienteBelle } from "./belle/api";
import { PROVEDOR } from "./provedor";

/** Tempo para o Belle responder quando quem espera é o webhook do WhatsApp. */
const ESPERA_NA_HORA_MS = 8_000;
/** Teto por rodada do sincronizador: 40 req/min no Belle, e a rodada ainda lê janelas. */
const LIMITE_POR_RODADA = 25;

export interface ResultadoDaDevolucao {
  devolvidas: number;
  recusadas: number;
}

interface Candidato {
  id: string;
  external_id: string;
  revision: number;
}

/**
 * Devolve ao Belle as confirmações pendentes de uma organização (ou só a de um
 * compromisso). Lança `TokenBelleInvalido` — quem chama decide o que fazer com a
 * conexão. Falha de rede encerra a leva sem lançar: o resto fica para a próxima.
 */
export async function devolverConfirmacoes(
  admin: SupabaseClient,
  organizationId: string,
  cliente: Pick<ClienteBelle, "alterarStatus">,
  opcoes: { agora?: Date; compromissoId?: string } = {},
): Promise<ResultadoDaDevolucao> {
  const resultado: ResultadoDaDevolucao = { devolvidas: 0, recusadas: 0 };
  const agora = opcoes.agora ?? new Date();

  let consulta = admin
    .from("calendar_appointments")
    .select("id, external_id, revision")
    .eq("organization_id", organizationId)
    .eq("external_provider", PROVEDOR)
    .eq("status", "confirmed")
    .not("client_responded_at", "is", null)
    // O Belle só aceita mexer em agendamento aberto e futuro; "Marcado" é o único
    // estado em que a confirmação do cliente ainda não está lá.
    .eq("external_status", "Marcado")
    .gt("starts_at", agora.toISOString());
  if (opcoes.compromissoId) consulta = consulta.eq("id", opcoes.compromissoId);
  const { data } = await consulta.order("starts_at", { ascending: true }).limit(LIMITE_POR_RODADA);

  for (const c of (data ?? []) as Candidato[]) {
    let resposta;
    try {
      resposta = await cliente.alterarStatus(c.external_id, "Confirmado");
    } catch (err) {
      if (err instanceof FalhaNoBelle) {
        logger.warn("[agenda-externa] Belle indisponível ao devolver confirmação", {
          organization_id: organizationId,
          erro: err.message,
        });
        break;
      }
      throw err;
    }

    if (!resposta.sucesso) {
      resultado.recusadas += 1;
      // Ex.: a recepção já mudou o status lá, ou o horário passou. A próxima leitura
      // do Belle atualiza o `external_status` e o compromisso deixa de ser candidato.
      logger.warn("[agenda-externa] Belle recusou a confirmação", {
        organization_id: organizationId,
        appointment_id: c.id,
        motivo: resposta.msg,
      });
      continue;
    }

    const { error } = await admin
      .from("calendar_appointments")
      .update({ external_status: "Confirmado", revision: c.revision + 1 })
      .eq("organization_id", organizationId)
      .eq("id", c.id)
      .eq("revision", c.revision);
    if (error) {
      // O Belle já confirmou; a próxima leitura traz "Confirmado" e fecha a conta.
      logger.warn("[agenda-externa] confirmação devolvida, mas o espelho local não atualizou", {
        organization_id: organizationId,
        appointment_id: c.id,
        erro: error.message,
      });
    }
    resultado.devolvidas += 1;
    await audit({
      action: "calendar_appointment.external_confirmed",
      organizationId,
      actorUserId: null,
      resourceType: "calendar_appointment",
      resourceId: c.id,
      metadata: { provedor: PROVEDOR, codigo: c.external_id },
      requestId: `agenda-externa:confirmacao:${c.id}`,
    });
  }
  return resultado;
}

/**
 * Chamada pela resposta do cliente ao botão: devolve ESTE compromisso ao Belle,
 * se a organização tiver o Belle conectado. Nunca lança — a resposta do cliente
 * já está gravada; se isto falhar, o sincronizador tenta de novo em até 10 min.
 */
export async function devolverConfirmacaoDoCompromisso(
  admin: SupabaseClient,
  organizationId: string,
  compromissoId: string,
): Promise<void> {
  try {
    const { data: integ } = await admin
      .from("calendar_integrations")
      .select("credential_encrypted, status")
      .eq("organization_id", organizationId)
      .eq("provider", PROVEDOR)
      .maybeSingle();
    const conexao = integ as { credential_encrypted: string; status: string } | null;
    if (!conexao || conexao.status === "invalid") return;

    const token = await decryptWebhookSecret(admin, conexao.credential_encrypted);
    if (!token) return;
    await devolverConfirmacoes(admin, organizationId, criarClienteBelle({ token, timeoutMs: ESPERA_NA_HORA_MS }), {
      compromissoId,
    });
  } catch (err) {
    if (!(err instanceof TokenBelleInvalido)) {
      logger.error("[agenda-externa] falha ao devolver confirmação", {
        organization_id: organizationId,
        appointment_id: compromissoId,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
    // Token recusado: a próxima rodada do sincronizador marca a conexão como inválida
    // e a tela pede um token novo — não duplicamos essa decisão aqui.
  }
}
