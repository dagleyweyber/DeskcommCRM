/**
 * A CONVERSA VIRA LEAD — o elo que faltava (spec 17 §3).
 *
 * ═══ O PROBLEMA, MEDIDO ═══
 *
 * Na produção deste projeto, em 2026-08-06: **32 conversas para 15 leads**, e
 * **13 dos 15 leads sem contato vinculado**. Varredura no repo: nenhum código
 * inseria em `crm_leads` a partir de conversa. Quem escrevia no WhatsApp virava
 * contato e parava ali.
 *
 * O `crm_leads.contact_id` sempre existiu, e a UI já o usa (`LeadDossier` abre a
 * timeline por contato). O vínculo não estava quebrado — estava **vazio**.
 *
 * ═══ POR QUE ISTO É O ANTI-MORTE, E NÃO CONVENIÊNCIA ═══
 *
 * O invariante 4 do sistema vivo diz que nenhuma demanda fica sem próximo passo.
 * Hoje **conversa fora do funil não é cobrada por ninguém**: nem pelo Radar de
 * Risco, nem pelo motor de follow-up — os dois trabalham sobre `crm_leads`.
 *
 * Alguém que escreveu, não foi respondido e não estava no funil desaparecia sem
 * deixar rastro em lugar nenhum que alguém olhe. O lead nascendo é o que coloca
 * essa pessoa no radar.
 *
 * ═══ O SISTEMA CRIA, NÃO O MODELO ═══
 *
 * Determinístico, no ingest. É a mesma razão da spec 16 impor o checkpoint em
 * vez de confiar numa tool: entrada de funil que depende de o modelo lembrar é
 * entrada que falha justamente no turno atípico.
 *
 * ═══ NADA É FIXO ═══
 *
 * O funil de entrada é `crm_pipelines.is_default` — que já existe, já tem tela e
 * já tem regra de exclusividade (`lib/pipelines/pipeline-editing.ts`). A etapa é
 * a de menor `position` entre as não-arquivadas. **Nenhum campo novo**: criar
 * `is_entry_pipeline` ou uma flag de primeira etapa seria um segundo lugar para
 * uma verdade que já existe, e é daí que a divergência nasce.
 *
 * Isto vale para o produto inteiro, não para uma organização: uma clínica, uma
 * imobiliária e um infoprodutor montam funis diferentes, e nenhum nome de funil
 * aparece neste arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { ehIdentificadorTecnico, rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import { formatLostReason } from "@/lib/schemas/leads";

import { emitLeadActivity } from "./activity-emitter";

/**
 * Janela de reativação (regra fixa da plataforma, decisão de produto de
 * 2026-09-12): reengajamento dentro deste prazo, depois de uma demanda
 * marcada perdida, REABRE a mesma demanda em vez de criar outra. Fora da
 * janela é ciclo de venda novo de verdade — mesma filosofia de sempre.
 *
 * Achado ao vivo (Ads Pro Company): "é comum um lead falar agora no
 * WhatsApp, não dar continuidade, e 3-5 dias depois chamar de novo — e isso
 * gera um lead novo", e o mesmo padrão para clique duplo de anúncio no
 * mesmo dia quando o lead da manhã já foi fechado antes do clique da
 * tarde. Um número FIXO pra toda a plataforma, não por pipeline — decisão
 * explícita: mais simples de entregar agora, e nada impede virar
 * `settings` por pipeline depois (mesmo padrão de `lost_reasons`) se algum
 * funil precisar de um número diferente.
 */
export const JANELA_DE_REATIVACAO_DIAS = 30;

/**
 * Por que um lead NÃO nasceu. Cada motivo é registrado — silêncio não distingue
 * "não devia nascer" de "falhou ao nascer", e a segunda é a que custa caro.
 */
export type MotivoSemLead =
  | "ja_existe" // o contato já tem lead aberto: um por demanda, não um por mensagem
  | "cliente_existente" // já foi cliente (became_customer_at) e não tem demanda aberta — reabrir negociação é ação humana, não automática (ver o cabeçalho da função)
  | "contato_bloqueado" // pediu para sair; criar oportunidade seria desrespeito registrado
  | "sem_funil_de_entrada" // a organização não tem funil padrão — falha de configuração, visível
  | "sem_etapa" // o funil existe e não tem etapa utilizável
  | "erro"; // qualquer falha de escrita

export type NascimentoDoLead =
  | {
      criado: true;
      leadId: string;
      pipelineId: string;
      stageId: string;
      /** `true` quando é a MESMA demanda reaberta (janela de reativação) — ver `JANELA_DE_REATIVACAO_DIAS`. Ausente/`false` = card genuinamente novo, comportamento de sempre. */
      reaberto?: boolean;
    }
  | { criado: false; motivo: MotivoSemLead; detalhe?: string };

export interface DadosDoNascimento {
  organizationId: string;
  contactId: string;
  /** conversa que originou — vai ao vínculo e ao registro. */
  conversationId: string;
  /** nome do contato, para o título do card. */
  nomeDoContato: string | null;
  /**
   * O clique em anúncio que originou a conversa, quando houver — genérico
   * de propósito (ver o comentário em `lib/channels/pos-entrada.ts`). Vira
   * `crm_leads.source_metadata`; é a peça que faz o dashboard e o futuro
   * envio ao Meta Conversions API saberem qual anúncio vendeu, não só que a
   * origem foi "meta_ads".
   */
  adReferral?: {
    clickId: string | null;
    sourceId?: string | null;
    headline?: string | null;
    sourceUrl?: string | null;
  } | null;
}

/**
 * O funil de entrada da organização e a etapa onde o lead nasce.
 *
 * Exportada porque a decisão "onde entra" precisa ser inspecionável por quem
 * configura (spec 17 §7, invariante 6): uma tela que queira dizer "novos
 * contatos entram em X, etapa Y" pergunta aqui, em vez de reimplementar a regra
 * e divergir dela.
 */
export async function funilDeEntrada(
  db: SupabaseClient,
  organizationId: string,
): Promise<{ pipelineId: string; stageId: string } | { erro: MotivoSemLead }> {
  const { data: funil } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();

  if (!funil) return { erro: "sem_funil_de_entrada" };

  // A PRIMEIRA etapa é a de menor `position` — a ordem do funil já diz qual é.
  // Etapas de ganho/perda ficam de fora: um lead não nasce fechado, e um funil
  // mal ordenado não pode fazer alguém entrar como "Perdido".
  const { data: etapa } = await db
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", funil.id)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!etapa) return { erro: "sem_etapa" };
  return { pipelineId: funil.id as string, stageId: etapa.id as string };
}

/**
 * Reabre uma demanda PERDIDA recentemente em vez de criar outra — o passo
 * 2.7 de `garantirLeadDaConversa`. Volta pra COLUNA DE ENTRADA do funil
 * (mesma `funilDeEntrada` de um lead genuinamente novo, e não a etapa onde
 * tinha parado antes de perder): decisão de produto deliberada — o
 * atendente triagem de novo do zero, porque a demanda esfriou o bastante
 * pra ter sido marcada perdida.
 *
 * `created_at` do lead NUNCA é tocado — quem olhar "há quanto tempo este
 * contato está na base" continua vendo o primeiro contato de verdade, não
 * hoje. A reabertura é sobre voltar a andar, não sobre nascer de novo.
 */
async function reabreLead(
  db: SupabaseClient,
  dados: DadosDoNascimento,
  leadPerdido: { id: string; closed_at: string; lost_reason: string | null },
): Promise<NascimentoDoLead> {
  const { organizationId, contactId, conversationId } = dados;

  const destino = await funilDeEntrada(db, organizationId);
  if ("erro" in destino) return { criado: false, motivo: destino.erro };

  // Atribuição fresca se ESTE reengajamento veio de um clique de anúncio novo
  // — o caso que motivou a regra (clicou de manhã, o lead da manhã já tinha
  // fechado, clicou nome de tarde). Sem clique novo, preserva a atribuição
  // que já existia: reabrir não pode apagar de onde a demanda veio da
  // primeira vez.
  const sourceMetadata = dados.adReferral
    ? {
        ...(dados.adReferral.clickId
          ? { ad_click_id: dados.adReferral.clickId, ad_click_id_type: "ctwa_clid" }
          : {}),
        ...(dados.adReferral.sourceId ? { ad_id: dados.adReferral.sourceId } : {}),
        ...(dados.adReferral.headline ? { ad_headline: dados.adReferral.headline } : {}),
        ...(dados.adReferral.sourceUrl ? { ad_source_url: dados.adReferral.sourceUrl } : {}),
      }
    : undefined;
  const temSourceMetadataFresca = sourceMetadata && Object.keys(sourceMetadata).length > 0;

  const { error } = await db
    .from("crm_leads")
    .update({
      status: "open",
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      // Volta a ser negociação em aberto — os dois campos de fechamento não
      // podem sobreviver, senão a demanda fica "aberta" com resquício de
      // "perdida" pro resto do sistema (relatório, filtro por motivo).
      closed_at: null,
      lost_reason: null,
      // Mesmo default de um card novo (coluna `position_in_stage` = 1000):
      // reabrir é a demanda se comportando como se tivesse acabado de entrar.
      position_in_stage: 1000,
      ...(temSourceMetadataFresca
        ? { source: "meta_ads", source_metadata: sourceMetadata }
        : {}),
    })
    .eq("id", leadPerdido.id)
    .eq("organization_id", organizationId);

  if (error) {
    return { criado: false, motivo: "erro", detalhe: error.message.slice(0, 120) };
  }

  const diasFechado = Math.max(
    0,
    Math.round((Date.now() - new Date(leadPerdido.closed_at).getTime()) / (24 * 60 * 60 * 1000)),
  );
  const motivoAnterior = leadPerdido.lost_reason ? formatLostReason(leadPerdido.lost_reason) : null;

  const evento = await db.rpc("emit_event", {
    p_event_type: "lead.reactivated",
    p_entity_kind: "crm_lead",
    p_entity_id: leadPerdido.id,
    p_payload: {
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      dias_fechado: diasFechado,
    },
    p_metadata: { source: "canal.ingest", conversation_id: conversationId },
    p_organization_id: organizationId,
  });
  if (evento.error) {
    logger.warn("nascimento-do-lead: emit_event lead.reactivated falhou", {
      organization_id: organizationId,
      lead_id: leadPerdido.id,
      error: evento.error.message.slice(0, 160),
    });
  }

  const registro = await emitLeadActivity(db, {
    organizationId,
    leadId: leadPerdido.id,
    contactId,
    type: "lead_reactivated",
    sourceModule: "canal.ingest",
    sourceId: conversationId,
    actor: { type: "webhook_source", id: "canal-inbound" },
    reason: motivoAnterior
      ? `Reaberto — voltou a falar ${diasFechado} dia(s) depois de ter sido marcado perdido (${motivoAnterior})`
      : `Reaberto — voltou a falar ${diasFechado} dia(s) depois de ter sido marcado perdido`,
    payload: { conversation_id: conversationId, dias_fechado: diasFechado },
  });
  if (!registro.ok) {
    logger.warn("nascimento-do-lead: atividade de reabertura não registrada", {
      organization_id: organizationId,
      lead_id: leadPerdido.id,
      error: registro.error?.slice(0, 120),
    });
  }

  return {
    criado: true,
    leadId: leadPerdido.id,
    pipelineId: destino.pipelineId,
    stageId: destino.stageId,
    reaberto: true,
  };
}

/**
 * Garante que a conversa tenha um lead. Idempotente por contato: chamar de novo
 * não cria um segundo card.
 *
 * **Um lead por DEMANDA, não por mensagem — com duas exceções deliberadas.**
 * Enquanto houver lead aberto para o contato, novas mensagens alimentam o que
 * já existe. Quando fecha `lost` e a pessoa volta a escrever DENTRO da
 * `JANELA_DE_REATIVACAO_DIAS`, a MESMA demanda reabre (passo 2.7) — regra
 * fixa da plataforma contra o card fantasma que poluía relatório ("lead fala
 * hoje, some, volta 3-5 dias depois, vira lead novo" — o mesmo padrão do
 * clique duplo de anúncio no mesmo dia, quando o primeiro já fechou antes do
 * segundo clique). Só FORA da janela nasce outro de verdade — aí é ciclo de
 * venda novo, ninguém comprou nada ainda.
 *
 * **Mas quando fecha porque a pessoa JÁ É CLIENTE** (`won`, ou reconhecida à
 * mão em `marcar-cliente-existente.ts` — o mesmo sinal, `contacts.
 * became_customer_at`), a próxima mensagem NÃO nasce card sozinha, e não
 * reabre nada — nem janela de reativação se aplica aqui. Ver o comentário no
 * passo 2.5 abaixo para o porquê.
 */
export async function garantirLeadDaConversa(
  db: SupabaseClient,
  dados: DadosDoNascimento,
): Promise<NascimentoDoLead> {
  const { organizationId, contactId, conversationId } = dados;

  // 1 · quem pediu para sair não vira oportunidade. O gate de envio já respeita
  // o opt-out; abrir um card para essa pessoa seria a mesma desatenção num
  // lugar onde ninguém olharia.
  const { data: contato } = await db
    .from("contacts")
    .select("is_blocked,display_name,name,phone_number,became_customer_at")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (contato?.is_blocked === true) return { criado: false, motivo: "contato_bloqueado" };

  // 2 · já existe demanda aberta?
  const { data: existente } = await db
    .from("crm_leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (existente) return { criado: false, motivo: "ja_existe" };

  // 2.5 · já é cliente (`became_customer_at`, gravado por `lead.won` — ver
  // cliente-existente-won-handler.ts — ou pelo reconhecimento manual em
  // marcar-cliente-existente.ts) e não tem demanda aberta?
  //
  // Não nasce card sozinho. O caso que expôs isto (B'Laser Caruaru): um lead
  // fecha `won` com um atendimento AGENDADO pra dias depois, a cliente escreve
  // de novo só pra CONFIRMAR aquele mesmo atendimento — e cada confirmação
  // virava um card novo de "lead", indistinguível de gente que nunca comprou
  // nada. Criar automaticamente aqui não tem como distinguir "está confirmando
  // o que já comprou" de "quer comprar de novo" — e nenhum CRM comercial
  // maduro tenta adivinhar isso da conversa: HubSpot/Close/Pipedrive nunca
  // recriam Deal sozinhos pra quem já é cliente, é sempre ação deliberada de
  // quem atende. A conversa continua viva no Inbox de qualquer jeito (lead e
  // conversa são desacoplados); o botão "Lead" do painel lateral (sempre
  // visível, `components/inbox/CRMSidePanel.tsx`) já é o caminho de UM clique
  // pra abrir negociação nova quando o atendente identificar interesse de
  // verdade — não precisa de tela nova.
  if (contato?.became_customer_at) return { criado: false, motivo: "cliente_existente" };

  // 2.7 · demanda PERDIDA recentemente (dentro da janela de reativação)?
  //
  // Reabre a MESMA demanda em vez de criar outra. Antes desta checagem, uma
  // demanda que fechasse `lost` e a pessoa voltasse a escrever dias depois
  // sempre virava card novo — "correto" pelo doutrina de "um lead por
  // demanda de verdade", mas medido como o principal poluidor de relatório:
  // o mesmo contato aparecendo como "lead novo" repetidas vezes por ter
  // esfriado e retomado o MESMO assunto, não por ter uma demanda nova.
  const cortaEm = new Date(
    Date.now() - JANELA_DE_REATIVACAO_DIAS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: perdidoRecente } = await db
    .from("crm_leads")
    .select("id, closed_at, lost_reason")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "lost")
    .gte("closed_at", cortaEm)
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (perdidoRecente) {
    return reabreLead(db, dados, perdidoRecente as { id: string; closed_at: string; lost_reason: string | null });
  }

  // 3 · onde entra
  const destino = await funilDeEntrada(db, organizationId);
  if ("erro" in destino) return { criado: false, motivo: destino.erro };

  // 4 · o card.
  //
  // O nome vem do CADASTRO, não do payload — e a correção é do próprio passo 1.
  // A versão anterior usava `notifyNameOf(p)` cru, então um contato conhecido
  // que mandasse uma mensagem sem nome no pacote (acontece em 2 de cada
  // 271 inbounds, e em TODO ack) abria um card chamado "Novo contato pelo
  // WhatsApp" — para alguém que o CRM conhece pelo nome.
  //
  // ⚠️ E o comentário que estava aqui MENTIA: dizia que "o chamador garante" que
  // o nome não é identificador técnico. O chamador (a ingestão do canal) passava
  // o payload cru, sem guarda nenhuma. Typecheck e testes passavam com a
  // afirmação falsa gravada no código. Quem garante agora é `rotuloDoContato` —
  // a MESMA função que as telas usam, para que o título do card e o nome no
  // inbox não possam divergir.
  //
  // O payload entra só como reforço: o upsert do contato roda ANTES deste ponto,
  // então o cadastro já incorporou o `pushName` desta mensagem.
  const doCadastro = rotuloDoContato(contato);
  const doPayload = (dados.nomeDoContato ?? "").trim();
  const titulo =
    doCadastro !== SEM_NOME
      ? doCadastro
      : doPayload !== "" && !ehIdentificadorTecnico(doPayload)
        ? doPayload
        : // "Sem nome" serve para uma linha de lista; um card de kanban precisa
          // dizer de onde veio, senão o quadro vira uma coluna de anônimos iguais.
          "Novo contato pelo WhatsApp";
  // O shape canônico de atribuição de anúncio — mesmo formato lido depois
  // pelo dashboard e pelo envio ao Meta Conversions API. `undefined` quando
  // não há clique de anúncio: comportamento de hoje, sem mudança pra quem
  // não anuncia. `clickId` pode faltar mesmo com `adReferral` presente (a
  // Meta manda `source_id` sem `ctwa_clid` em alguns formatos de anúncio) —
  // grava o que houver, sem inventar o que faltou.
  const sourceMetadata = dados.adReferral
    ? {
        ...(dados.adReferral.clickId
          ? { ad_click_id: dados.adReferral.clickId, ad_click_id_type: "ctwa_clid" }
          : {}),
        ...(dados.adReferral.sourceId ? { ad_id: dados.adReferral.sourceId } : {}),
        ...(dados.adReferral.headline ? { ad_headline: dados.adReferral.headline } : {}),
        ...(dados.adReferral.sourceUrl ? { ad_source_url: dados.adReferral.sourceUrl } : {}),
      }
    : undefined;
  const temSourceMetadata = sourceMetadata && Object.keys(sourceMetadata).length > 0;

  const { data: lead, error } = await db
    .from("crm_leads")
    .insert({
      organization_id: organizationId,
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      contact_id: contactId,
      title: titulo,
      // `temSourceMetadata` só é truthy quando `parseAdReferral`/`adReferralDe`
      // já confirmaram um clique de anúncio de verdade (clickId ou sourceId
      // presente) — mesmo critério usado pelo dashboard e pelo Meta Ads Fase
      // A. "meta_ads" é valor existente no vocabulário aberto de `source`
      // (`lib/leads/lead-form-shared.ts`), o mesmo que um humano escolheria
      // manualmente pra um lead vindo de anúncio; sem isso, todo lead pago
      // ficava indistinguível de tráfego orgânico do WhatsApp nos relatórios.
      source: temSourceMetadata ? "meta_ads" : "whatsapp",
      ...(temSourceMetadata ? { source_metadata: sourceMetadata } : {}),
    })
    .select("id")
    .single();

  if (error || !lead) {
    return { criado: false, motivo: "erro", detalhe: error?.message.slice(0, 120) };
  }

  // 4.5 · avisa o resto do sistema que um lead nasceu.
  //
  // A criação MANUAL (`app/api/v1/leads/_handler.ts`) já emite `lead.created`
  // desde sempre; este caminho — o que cria a imensa maioria dos leads, um por
  // conversa de WhatsApp — nunca emitia. Handlers que dependem deste evento
  // (resolução de campanha do Meta Ads, regras de automação em "lead criado")
  // rodavam só para o punhado de leads criados à mão, e todo lead orgânico
  // ficava com anúncio capturado mas campanha jamais resolvida — achado ao
  // vivo num cliente real, não suposição.
  //
  // O trigger `fn_emit_event_on_lead_change` (migration 0043) deliberadamente
  // NÃO emite em INSERT — a duplicata era o bug que aquela migration corrigiu.
  // A responsabilidade é de quem insere, e este é o segundo (e último) lugar
  // que insere em `crm_leads` fora daquela rota.
  const evento = await db.rpc("emit_event", {
    p_event_type: "lead.created",
    p_entity_kind: "crm_lead",
    p_entity_id: lead.id as string,
    p_payload: {
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      title: titulo,
    },
    p_metadata: { source: "canal.ingest", conversation_id: conversationId },
    p_organization_id: organizationId,
  });
  if (evento.error) {
    logger.warn("nascimento-do-lead: emit_event lead.created falhou", {
      organization_id: organizationId,
      lead_id: lead.id as string,
      error: evento.error.message.slice(0, 160),
    });
  }

  // 5 · o registro, pelo EMISSOR CANÔNICO — não por insert cru.
  //
  // `emitLeadActivity` existe porque há vários escritores da timeline e o tipo
  // solto foi como a tela e o banco divergiram antes. Ele também é
  // fire-and-forget por desenho: a timeline não derruba a operação que descreve.
  //
  // Sem esta linha o card aparece no kanban sem que ninguém saiba de onde veio —
  // e "apareceu sozinho" é como se perde a confiança num automatismo
  // (invariante 3 do sistema vivo).
  const registro = await emitLeadActivity(db, {
    organizationId,
    leadId: lead.id as string,
    contactId,
    type: "lead_created",
    // `canal.ingest`, e não o nome da tecnologia: a doutrina de restrição de
    // canal (invariante 1) proíbe feature nomear provider — quem sabe qual é o
    // provider é `lib/channels/`. Aqui o que importa é o QUE originou (a
    // ingestão de uma mensagem de canal), não POR ONDE ela entrou.
    sourceModule: "canal.ingest",
    sourceId: conversationId,
    // `webhook_source` e não um "system" inventado: `actorParaAtividade` já
    // traduz esta variante para `kind: "system"` na timeline, e ela descreve o
    // que de fato aconteceu — a mensagem chegou por webhook, o produto agiu.
    actor: { type: "webhook_source", id: "canal-inbound" },
    reason: "primeira mensagem recebida no WhatsApp",
    payload: { conversation_id: conversationId },
  });
  if (!registro.ok) {
    // O lead existe e é o que importa; a linha da timeline falhou. Devolver erro
    // aqui faria o chamador achar que o card não nasceu — e ele nasceu.
    logger.warn("nascimento-do-lead: atividade não registrada", {
      organization_id: organizationId,
      lead_id: lead.id as string,
      error: registro.error?.slice(0, 120),
    });
  }

  return {
    criado: true,
    leadId: lead.id as string,
    pipelineId: destino.pipelineId,
    stageId: destino.stageId,
  };
}
