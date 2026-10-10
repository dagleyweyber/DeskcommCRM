/**
 * Classificação da saúde de cada clínica — a régua, em um lugar só.
 *
 * `fn_saude_das_clinicas()` (migration 0186) devolve FATO cru: quantos canais
 * estão WORKING, quantas mensagens falharam, há quanto tempo o evento mais
 * antigo espera. Quem transforma isso em "ok / atenção / crítico" é esta
 * função pura — mesma divisão que `admin/tenants/[id]/health` já usa, e pela
 * mesma razão: limiar é decisão de produto, muda com a operação, e precisa de
 * teste. Limiar dentro de SQL não tem teste e vira régua duplicada.
 *
 * ## Por que cada sinal existe (todos vieram de incidente real, não de teoria)
 *
 * - **canal**: clínica sem nenhuma sessão WORKING está surda e muda no
 *   WhatsApp. É a falha mais grave e a mais invisível — o CRM continua
 *   abrindo normalmente.
 * - **ia**: agente PUBLICADO + nenhuma credencial utilizável = a IA aceita o
 *   turno e falha em silêncio. B'Laser Caruaru e RevitaFio Carpina passaram
 *   SEMANAS assim, sem nenhum alarme em lugar nenhum.
 * - **fila**: evento parado há dias significa efeito que nunca aconteceu
 *   (mensagem não enviada, etapa não movida). O backlog encontrado nesta
 *   semana tinha 48 DIAS.
 * - **mensagens**: falha de envio é dinheiro parado — cliente que não recebeu
 *   resposta.
 * - **mortos / avisos**: trabalho que esgotou as tentativas e avisos abertos
 *   na Central da própria clínica.
 *
 * ## A regra do alarme falso
 *
 * Clínica SUSPENSA sai como `suspenso`, nunca como `critico`: canal parado
 * numa conta suspensa é o esperado, não um problema. Clínica que não usa IA
 * (nenhum agente publicado) não é cobrada por credencial. Painel que grita
 * sobre o que é normal ensina a ignorar o painel — e aí ele não serve para o
 * dia em que gritar de verdade.
 *
 * ## `onboarded_at` decide o que "zero canal" SIGNIFICA (migration 0189)
 *
 * Zero canal é tolerável enquanto a clínica ainda está sendo configurada —
 * por isso "atenção", nunca "crítico", nessa janela. Mas o MESMO zero canal
 * numa clínica que já terminou o onboarding há meses é idêntico, na prática, a
 * "canal conectado e caiu": ninguém está recebendo mensagem. Sem essa
 * distinção, essa clínica ficaria muda pra sempre sem o vigia (item 3) jamais
 * abrir incidente — ele só age em crítico.
 */

import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

export type Saude = "ok" | "atencao" | "critico" | "suspenso";

/**
 * Os `event_type` que ALGUÉM de fato consome — o argumento de
 * `fn_saude_das_clinicas()` (migration 0187).
 *
 * Existe porque "fila parada" só faz sentido para COMANDO (`*_requested`, que
 * sem consumidor nunca é atendido). Evento de FATO (`message.outbound`,
 * `lead.lost`, `channel_session.status_changed`…) fica `pending` para sempre
 * por desenho, e contá-lo gerava alarme falso: no primeiro ciclo em produção o
 * vigia abriu "fila parada" para 5 de 7 clínicas, com até 49 dias — nenhuma
 * tinha trabalho atrasado.
 *
 * A lista vem do REGISTRO, nunca de uma cópia: handler novo entra aqui
 * sozinho, e tipo que perde o handler sai sozinho.
 */
export function tiposAcionaveis(): string[] {
  ensureHandlersRegistered();
  return [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
}

/** Uma linha crua de `fn_saude_das_clinicas()`. */
export interface SinaisDaClinica {
  organization_id: string;
  display_name: string;
  slug: string;
  status: string;
  suspended_at: string | null;
  onboarded_at: string | null;
  canais_total: number;
  canais_working: number;
  agentes_publicados: number;
  credenciais_ia_ativas: number;
  mensagens_falhas_24h: number;
  fila_pendente_desde: string | null;
  eventos_mortos_7d: number;
  avisos_abertos: number;
  ultima_mensagem_at: string | null;
}

export interface SinalClassificado {
  saude: Saude;
  /** Texto curto para a célula da tabela. Nunca vazio. */
  detalhe: string;
}

export interface SaudeDaClinica {
  organization_id: string;
  display_name: string;
  slug: string;
  /** O pior entre os sinais — é por ele que a lista é ordenada. */
  geral: Saude;
  canal: SinalClassificado;
  ia: SinalClassificado;
  fila: SinalClassificado;
  mensagens: SinalClassificado;
  avisos: SinalClassificado;
  ultima_mensagem_at: string | null;
}

/** Limiares, explícitos e num lugar só — mexer aqui é mexer na régua. */
export const LIMIARES = {
  /** Fila: minutos do evento pendente mais antigo. */
  filaAtencaoMin: 30,
  filaCriticoMin: 60 * 12,
  /** Mensagens falhas nas últimas 24h. */
  mensagensAtencao: 1,
  mensagensCritico: 10,
  /** Eventos que esgotaram as tentativas nos últimos 7 dias. */
  mortosAtencao: 1,
  mortosCritico: 20,
} as const;

const ORDEM: Record<Saude, number> = { critico: 3, atencao: 2, ok: 1, suspenso: 0 };

/** O pior entre vários sinais. `suspenso` nunca contamina — é estado, não falha. */
export function pior(...saudes: Saude[]): Saude {
  return saudes.reduce<Saude>((acc, s) => (ORDEM[s] > ORDEM[acc] ? s : acc), "ok");
}

function classificaCanal(s: SinaisDaClinica): SinalClassificado {
  if (s.canais_total === 0) {
    // Onboarding concluído e zero canal: não é "ainda configurando", é
    // clínica ao vivo e muda. Mesma gravidade de "conectado e caiu" — ver o
    // cabeçalho desta função (migration 0189).
    if (s.onboarded_at !== null) {
      return { saude: "critico", detalhe: "Onboarding concluído sem nenhum canal conectado" };
    }
    return { saude: "atencao", detalhe: "Nenhum canal conectado" };
  }
  if (s.canais_working === 0) {
    return { saude: "critico", detalhe: `0 de ${s.canais_total} no ar` };
  }
  if (s.canais_working < s.canais_total) {
    return { saude: "atencao", detalhe: `${s.canais_working} de ${s.canais_total} no ar` };
  }
  return { saude: "ok", detalhe: `${s.canais_working} no ar` };
}

function classificaIa(s: SinaisDaClinica): SinalClassificado {
  if (s.agentes_publicados === 0) {
    return { saude: "ok", detalhe: "Não usa IA" };
  }
  if (s.credenciais_ia_ativas === 0) {
    // O incidente silencioso: agente no ar, respondendo nada.
    return { saude: "critico", detalhe: "Agente publicado SEM credencial válida" };
  }
  return { saude: "ok", detalhe: `${s.agentes_publicados} agente(s) com credencial` };
}

function classificaFila(s: SinaisDaClinica, agora: Date): SinalClassificado {
  if (s.fila_pendente_desde === null) {
    return { saude: "ok", detalhe: "Fila vazia" };
  }
  const minutos = Math.floor(
    (agora.getTime() - new Date(s.fila_pendente_desde).getTime()) / 60_000,
  );
  const texto = minutos >= 60 * 24
    ? `${Math.floor(minutos / (60 * 24))}d parada`
    : minutos >= 60
      ? `${Math.floor(minutos / 60)}h parada`
      : `${Math.max(minutos, 0)}min`;

  if (minutos >= LIMIARES.filaCriticoMin) return { saude: "critico", detalhe: texto };
  if (minutos >= LIMIARES.filaAtencaoMin) return { saude: "atencao", detalhe: texto };
  return { saude: "ok", detalhe: texto };
}

function classificaMensagens(s: SinaisDaClinica): SinalClassificado {
  if (s.mensagens_falhas_24h >= LIMIARES.mensagensCritico) {
    return { saude: "critico", detalhe: `${s.mensagens_falhas_24h} falhas em 24h` };
  }
  if (s.mensagens_falhas_24h >= LIMIARES.mensagensAtencao) {
    return { saude: "atencao", detalhe: `${s.mensagens_falhas_24h} falha(s) em 24h` };
  }
  return { saude: "ok", detalhe: "Sem falhas" };
}

function classificaAvisos(s: SinaisDaClinica): SinalClassificado {
  const partes: string[] = [];
  if (s.avisos_abertos > 0) partes.push(`${s.avisos_abertos} aviso(s)`);
  if (s.eventos_mortos_7d > 0) partes.push(`${s.eventos_mortos_7d} evento(s) morto(s)`);

  if (s.eventos_mortos_7d >= LIMIARES.mortosCritico) {
    return { saude: "critico", detalhe: partes.join(" · ") };
  }
  if (s.eventos_mortos_7d >= LIMIARES.mortosAtencao || s.avisos_abertos > 0) {
    return { saude: "atencao", detalhe: partes.join(" · ") };
  }
  return { saude: "ok", detalhe: "Nada aberto" };
}

export function classificaClinica(s: SinaisDaClinica, agora: Date = new Date()): SaudeDaClinica {
  const suspensa = s.suspended_at !== null || s.status === "suspended";

  const canal = classificaCanal(s);
  const ia = classificaIa(s);
  const fila = classificaFila(s, agora);
  const mensagens = classificaMensagens(s);
  const avisos = classificaAvisos(s);

  return {
    organization_id: s.organization_id,
    display_name: s.display_name,
    slug: s.slug,
    // Conta suspensa não dispara alarme: canal parado ali é o esperado, e
    // alarme falso ensina a ignorar o painel.
    geral: suspensa
      ? "suspenso"
      : pior(canal.saude, ia.saude, fila.saude, mensagens.saude, avisos.saude),
    canal,
    ia,
    fila,
    mensagens,
    avisos,
    ultima_mensagem_at: s.ultima_mensagem_at,
  };
}

/** Pior primeiro: quem precisa de socorro aparece no topo, sem precisar filtrar. */
export function ordenaPorGravidade(clinicas: readonly SaudeDaClinica[]): SaudeDaClinica[] {
  return [...clinicas].sort((a, b) => {
    const delta = ORDEM[b.geral] - ORDEM[a.geral];
    return delta !== 0 ? delta : a.display_name.localeCompare(b.display_name, "pt-BR");
  });
}
