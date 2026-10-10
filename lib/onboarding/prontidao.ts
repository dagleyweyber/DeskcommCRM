/**
 * Prontidão para concluir o onboarding — a validação que faltava.
 *
 * Achado revisando o item 4 do plano de escala (preparação para 50 clínicas):
 * `finishOnboarding()` (`app/actions/onboarding/finishOnboarding.ts`) sempre
 * marcou `onboarded_at` sem checar NADA. Foi exatamente esse buraco que
 * deixou B'Laser Caruaru e RevitaFio Carpina terminarem o cadastro com o
 * Atendente de IA publicado e SEM credencial válida — a IA aceitava o turno
 * do cliente e falhava em silêncio, por semanas, sem nenhum aviso em lugar
 * nenhum.
 *
 * ## Por que só estes dois sinais travam (não os cinco do painel)
 *
 * O painel de saúde (`lib/admin/saude-das-clinicas.ts`) tem cinco sinais, mas
 * a maioria não faz sentido no instante zero: "mensagens falhando" e "eventos
 * mortos" exigem HISTÓRICO que uma clínica recém-criada não tem — cobrar isso
 * aqui seria alarme sobre o que nunca aconteceu. Só dois sinais são travas
 * genuínas de "isto está pronto pra operar":
 *
 *   - canal: sem WhatsApp funcionando, a clínica não recebe mensagem nenhuma.
 *     Produto de WhatsApp sem WhatsApp conectado não está pronto, ponto.
 *   - IA: agente publicado sem credencial é o incidente provado — a
 *     combinação que já custou semanas de silêncio pra duas clínicas reais.
 *
 * ## Por que NÃO reusa `classificaClinica` direto
 *
 * `classificaClinica` decide "zero canal" como atenção/crítico usando
 * `onboarded_at` (migration 0189) — mas `onboarded_at` é exatamente o campo
 * que ESTA função está prestes a decidir se pode ser preenchido. Usá-lo aqui
 * seria o problema do ovo e da galinha: no instante da checagem ele ainda é
 * `null`, então "zero canal" sempre sairia como atenção (tolerável) e nunca
 * bloquearia nada — o oposto do que esta peça existe para fazer. O gate de
 * conclusão tem sua própria pergunta, mais simples e binária: "dá pra
 * terminar agora?", não "que gravidade isso tem no painel contínuo?".
 *
 * ## O que isto NÃO bloqueia (de propósito)
 *
 * Nuvemshop e convites de time continuam puláveis — a própria tela de
 * conclusão já mostra "(pulado)" para eles, e não há incidente real ligado a
 * pular essas duas etapas. Travar tudo "porque dá pra travar" ensinaria a
 * burlar o fluxo em vez de preveni-lo.
 */

export interface SinaisDeProntidao {
  canais_working: number;
  agentes_publicados: number;
  credenciais_ia_ativas: number;
}

/** Uma pendência que bloqueia a conclusão — sempre com o porquê, nunca só um código. */
export interface PendenciaCritica {
  motivo: "sem_canal_funcionando" | "ia_sem_credencial";
  mensagem: string;
}

/**
 * As pendências que impedem concluir o onboarding agora. Lista vazia = pronto.
 */
export function pendenciasParaConcluir(s: SinaisDeProntidao): PendenciaCritica[] {
  const pendencias: PendenciaCritica[] = [];

  if (s.canais_working === 0) {
    pendencias.push({
      motivo: "sem_canal_funcionando",
      mensagem: "Nenhum canal de WhatsApp conectado e funcionando.",
    });
  }

  if (s.agentes_publicados > 0 && s.credenciais_ia_ativas === 0) {
    pendencias.push({
      motivo: "ia_sem_credencial",
      mensagem:
        "O Atendente de IA está publicado, mas não há nenhuma credencial de IA ativa e validada — ele vai falhar em silêncio a cada mensagem.",
    });
  }

  return pendencias;
}
