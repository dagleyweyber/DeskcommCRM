/**
 * "O botão do WhatsApp está sendo rastreado?" — cliques registrados × conversas ligadas.
 *
 * O rastreio do botão é melhor-esforço (a pessoa pode apagar o código `ref:` antes de enviar
 * a mensagem), então a taxa de ligação é o que diz se ele está funcionando. Sem este
 * resumo, o código poderia estar sendo apagado em toda mensagem e ninguém saberia: o lead
 * nasce sem origem e a conversão nunca volta ao Google.
 *
 * Puro: a rota conta e entrega os números aqui.
 */

export interface ResumoDeCliques {
  dias: number;
  cliques: number;
  ligados: number;
  /** 0–100, ou null quando ainda não há cliques para medir. */
  taxa: number | null;
  /** Frase para a tela — o que os números querem dizer e, se preciso, o que fazer. */
  leitura: string;
}

/** Abaixo disto, com amostra suficiente, o código está se perdendo no caminho. */
export const TAXA_MINIMA_ESPERADA = 30;
/** Menos cliques que isto não permite concluir nada. */
export const AMOSTRA_MINIMA = 10;

export function resumeCliques(cliques: number, ligados: number, dias = 30): ResumoDeCliques {
  const total = Math.max(0, Math.floor(cliques));
  const lig = Math.min(Math.max(0, Math.floor(ligados)), total);
  const taxa = total > 0 ? Math.round((lig / total) * 100) : null;

  let leitura: string;
  if (total === 0) {
    leitura = "Nenhum clique no botão do WhatsApp registrado ainda. Confira se o script está na página e se o botão leva a um link wa.me ou api.whatsapp.com.";
  } else if (total < AMOSTRA_MINIMA) {
    leitura = `${total} clique(s) até agora — ainda são poucos para dizer se o rastreio está funcionando.`;
  } else if (taxa !== null && taxa < TAXA_MINIMA_ESPERADA) {
    leitura =
      "Poucas conversas chegam com o código. Confira se a mensagem pronta do botão não está sendo apagada ou editada antes do envio — sem o código, a conversa nasce sem origem.";
  } else {
    leitura = "O rastreio do botão está funcionando.";
  }
  return { dias, cliques: total, ligados: lig, taxa, leitura };
}
