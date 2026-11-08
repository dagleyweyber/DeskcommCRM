/**
 * Configuração de uma automação de modelo — as regras que valem na CRIAÇÃO
 * (POST /api/v1/automations) e na EDIÇÃO (PATCH /api/v1/automations/[id]).
 *
 * Existe para as duas rotas não divergirem: editar não pode aceitar o que criar
 * recusaria (modelo não aprovado, variável sem origem, botão que o modelo não
 * tem, serviço de outra organização). Sem módulo comum, a regra mudaria numa
 * rota e a outra viraria a porta dos fundos.
 *
 * Tudo aqui é puro, ou recebe o cliente admin já com a `organization_id`
 * resolvida de fonte confiável (nunca do corpo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { botoesDeRespostaRapida, normalizaTextoDeBotao } from "@/lib/agenda/botoes";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import { slotsDeLinkDaCampanha } from "@/lib/channels/template-conteudo";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

export type TimingKind = "day_of_8am" | "days_before" | "hours_before";

/** O que define COMO e QUANDO a automação fala — tudo menos canal e gatilho. */
export interface ConfiguracaoDaAutomacao {
  name: string;
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
  event_type_id: string | null;
  timing_kind: TimingKind;
  timing_value: number | null;
  confirm_button_text: string | null;
  decline_button_text: string | null;
}

/** Os campos que a edição pode mexer. Canal e gatilho NÃO estão aqui, de propósito. */
export const CAMPOS_EDITAVEIS = [
  "name",
  "template_name",
  "template_language",
  "variable_mapping",
  "event_type_id",
  "timing_kind",
  "timing_value",
  "confirm_button_text",
  "decline_button_text",
] as const satisfies ReadonlyArray<keyof ConfiguracaoDaAutomacao>;

export type CampoEditavel = (typeof CAMPOS_EDITAVEIS)[number];

export const MENSAGEM_MOMENTO_INVALIDO = "Momento de envio inválido: 1 a 7 dias antes, ou 1 a 72 horas antes.";

/** Mesma regra do CHECK do banco (migration 0201): dias 1–7, horas 1–72, "no dia" sem valor. */
export function momentoValido(kind: TimingKind, value: number | null): boolean {
  if (kind === "day_of_8am") return value === null;
  if (value === null) return false;
  return kind === "days_before" ? value <= 7 : true;
}

/** Quais campos editáveis mudaram de um estado para o outro (comparação por valor). */
export function camposAlterados(
  antes: ConfiguracaoDaAutomacao,
  depois: ConfiguracaoDaAutomacao,
): CampoEditavel[] {
  return CAMPOS_EDITAVEIS.filter((c) => JSON.stringify(antes[c]) !== JSON.stringify(depois[c]));
}

/**
 * Trocar o texto de um botão muda o que a RESPOSTA do cliente significa: o
 * casamento da resposta com o compromisso (`lib/agenda/confirmacao.ts`) lê o
 * texto ATUAL da automação. Mensagens já enviadas com o botão antigo deixariam
 * de casar, e a confirmação se perderia em silêncio.
 */
export function mudouBotoes(antes: ConfiguracaoDaAutomacao, depois: ConfiguracaoDaAutomacao): boolean {
  const n = (t: string | null) => (t ? normalizaTextoDeBotao(t) : null);
  return (
    n(antes.confirm_button_text) !== n(depois.confirm_button_text) ||
    n(antes.decline_button_text) !== n(depois.decline_button_text)
  );
}

/**
 * Mexeu no que decide A QUEM e QUANDO a automação responde — é o que a trava
 * única de "uma ativa por serviço e momento" olha.
 */
export function mudouAlvoOuMomento(antes: ConfiguracaoDaAutomacao, depois: ConfiguracaoDaAutomacao): boolean {
  return (
    antes.event_type_id !== depois.event_type_id ||
    antes.timing_kind !== depois.timing_kind ||
    antes.timing_value !== depois.timing_value
  );
}

export type ResultadoDaValidacao =
  | { ok: true }
  | { ok: false; mensagem: string; details?: Record<string, unknown> };

/**
 * As conferências que dependem do banco: canal da organização e de pé, modelo
 * aprovado NAQUELE canal, botões que o modelo realmente tem, serviço ativo da
 * organização e toda variável com origem. Mesma sequência e mesmas frases da
 * criação — a ordem importa porque a primeira falha é a que a pessoa lê.
 *
 * `exigirCanalNoAr`: a criação recusa canal fora do ar; a edição de uma
 * automação PAUSADA por queda do canal não deveria ficar presa por isso, então
 * ela passa `false` quando o canal não é o que está sendo mudado (e ele nunca é).
 */
export async function validarConfiguracao(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
  cfg: ConfiguracaoDaAutomacao,
  opcoes: { exigirCanalNoAr: boolean },
): Promise<ResultadoDaValidacao> {
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, status")
    .eq("id", channelSessionId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!sessao) return { ok: false, mensagem: "Canal não encontrado nesta organização." };
  if (opcoes.exigirCanalNoAr && sessao.status !== "WORKING") {
    return { ok: false, mensagem: "O canal escolhido não está conectado." };
  }

  const { data: template } = await admin
    .from("meta_templates")
    .select("status, components, parameter_format")
    .eq("organization_id", orgId)
    .eq("channel_session_id", channelSessionId)
    .eq("name", cfg.template_name)
    .eq("language", cfg.template_language)
    .maybeSingle();
  if (!template || template.status !== "APPROVED") {
    return {
      ok: false,
      mensagem:
        "Este modelo não está aprovado para este canal — sincronize em Conexões antes de criar a automação.",
    };
  }

  // O link desse botão nasce na criação de cada CAMPANHA (migration 0216). A automação
  // não tem esse passo: mandaria `<crm>/l/<o que foi digitado>`, um link quebrado.
  if (slotsDeLinkDaCampanha(template.components).length > 0) {
    return {
      ok: false,
      mensagem:
        "Este modelo tem botão com link escolhido na campanha — ele só funciona em campanha, não em automação.",
    };
  }

  // O serviço precisa ser desta organização e estar ativo na Agenda: uma automação presa a
  // um serviço que não existe nunca dispararia, e em silêncio.
  if (cfg.event_type_id) {
    const { data: servico } = await admin
      .from("calendar_event_types")
      .select("id, is_active")
      .eq("id", cfg.event_type_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!servico || servico.is_active === false) {
      return { ok: false, mensagem: "Serviço não encontrado na Agenda desta organização." };
    }
  }

  // O botão escolhido precisa existir no modelo — senão a resposta do cliente
  // nunca casaria e a confirmação ficaria muda sem ninguém saber por quê.
  const botoes = botoesDeRespostaRapida(template.components).map(normalizaTextoDeBotao);
  for (const escolhido of [cfg.confirm_button_text, cfg.decline_button_text]) {
    if (escolhido && !botoes.includes(normalizaTextoDeBotao(escolhido))) {
      return { ok: false, mensagem: `O modelo não tem o botão "${escolhido}".` };
    }
  }

  // Toda variável do modelo precisa de uma origem: sem isso toda ocorrência
  // falharia com `template_missing_values` no primeiro envio.
  const faltando = valoresSemFonte(
    {
      name: cfg.template_name,
      language: cfg.template_language,
      parameter_format: template.parameter_format ?? undefined,
      components: template.components as Definicao["components"],
    },
    cfg.variable_mapping,
  );
  if (faltando.length > 0) {
    return {
      ok: false,
      mensagem: fraseDosValoresSemFonte(faltando),
      details: { variaveis_sem_origem: faltando.map((f) => f.rotulo) },
    };
  }

  return { ok: true };
}

/** A frase do conflito de "uma ativa por serviço e momento" — a mesma na ativação e na edição. */
export function fraseDoConflito(porServico: boolean, nomeDaOutra: string): string {
  return `Já existe uma automação ativa para ${porServico ? "este serviço" : "todos os serviços"} no mesmo momento de envio: "${nomeDaOutra}". Pause-a antes de ativar esta — duas ativas mandariam a mensagem em dobro.`;
}

/**
 * Outra automação ATIVA no mesmo serviço e momento de envio. Duas ativas
 * mandariam a mensagem em dobro; o índice único do banco é a trava final contra
 * a corrida, esta consulta existe para dizer qual é e o que fazer.
 */
export async function acharConflitoDeAtivacao(
  admin: SupabaseClient,
  orgId: string,
  alvo: {
    id: string;
    trigger_kind: string;
    event_type_id: string | null;
    timing_kind: string;
    timing_value: number | null;
  },
): Promise<{ id: string; name: string } | null> {
  let consulta = admin
    .from("whatsapp_template_automations")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("trigger_kind", alvo.trigger_kind)
    .eq("status", "active")
    .eq("timing_kind", alvo.timing_kind)
    .neq("id", alvo.id);
  consulta = alvo.timing_value === null ? consulta.is("timing_value", null) : consulta.eq("timing_value", alvo.timing_value);
  consulta = alvo.event_type_id ? consulta.eq("event_type_id", alvo.event_type_id) : consulta.is("event_type_id", null);
  const { data } = await consulta.limit(1).maybeSingle();
  return data ? { id: data.id as string, name: data.name as string } : null;
}

/** Janela em que uma resposta a um envio ainda pode chegar (envio até 7 dias antes + folga). */
const JANELA_DE_RESPOSTAS_DIAS = 10;
const LOTE_DE_IDS = 200;

/**
 * Quantos envios desta automação ainda esperam resposta do cliente: o
 * compromisso continua `pending` e no futuro. É o que trocar os botões
 * perderia em silêncio.
 */
export async function confirmacoesAguardandoResposta(
  admin: SupabaseClient,
  orgId: string,
  automationId: string,
  agora: Date,
): Promise<number> {
  const desde = new Date(agora.getTime() - JANELA_DE_RESPOSTAS_DIAS * 86_400_000).toISOString();
  const { data: envios } = await admin
    .from("whatsapp_template_automation_sends")
    .select("appointment_id")
    .eq("automation_id", automationId)
    .eq("organization_id", orgId)
    .eq("status", "sent")
    .not("appointment_id", "is", null)
    .gte("sent_at", desde);
  const ids = [...new Set((envios ?? []).map((e) => e.appointment_id as string))];

  let total = 0;
  for (let i = 0; i < ids.length; i += LOTE_DE_IDS) {
    const { count } = await admin
      .from("calendar_appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .in("id", ids.slice(i, i + LOTE_DE_IDS))
      .eq("status", "pending")
      .gt("starts_at", agora.toISOString());
    total += count ?? 0;
  }
  return total;
}
