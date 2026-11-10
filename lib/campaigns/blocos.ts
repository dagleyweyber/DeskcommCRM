/**
 * ESPERA PROGRAMADA: a campanha manda em blocos, com uma espera entre eles.
 *
 * Ex.: 1.000 contatos, blocos de 300 e espera de 30 min → 300, espera, 300, espera, 300,
 * espera, 100. Serve para o número "respirar" e para a equipe dar conta das respostas de cada
 * leva — é o que se faz na mão quando não há como programar.
 *
 * Puro (sem banco): o despachante usa para saber quanto cabe no bloco, e o formulário para
 * mostrar a previsão antes de criar. O bloco conta TENTATIVAS (o que saiu e o que falhou):
 * é isso que o operador quer dizer com "a cada 300 mensagens".
 */
export const BLOCO_MINIMO = 10;
export const BLOCO_MAXIMO = 100_000;
export const ESPERA_MINIMA_MIN = 1;
export const ESPERA_MAXIMA_MIN = 1440;

export interface ConfigDeBlocos {
  tamanho: number;
  esperaMinutos: number;
}

export function blocosDe(c: {
  bloco_tamanho?: number | null;
  bloco_espera_minutos?: number | null;
}): ConfigDeBlocos | null {
  if (!c.bloco_tamanho || !c.bloco_espera_minutos) return null;
  return { tamanho: c.bloco_tamanho, esperaMinutos: c.bloco_espera_minutos };
}

/** Quantos da próxima rodada cabem no bloco em andamento (o lote nunca atravessa a espera). */
export function quantosCabem(cfg: ConfigDeBlocos | null, enviadosNoBloco: number, lote: number): number {
  if (!cfg) return lote;
  return Math.max(0, Math.min(lote, cfg.tamanho - enviadosNoBloco));
}

/** A campanha está esperando o próximo bloco agora? */
export function emEspera(proximoBlocoEm: string | null | undefined, agora: Date): boolean {
  return Boolean(proximoBlocoEm && new Date(proximoBlocoEm).getTime() > agora.getTime());
}

/** Previsão para a tela: quantos blocos e quanto tempo, contando as esperas. */
export function previsaoDosBlocos(
  total: number,
  cfg: ConfigDeBlocos,
  porHora: number,
): { blocos: number; esperas: number; minutos: number } {
  const blocos = Math.max(1, Math.ceil(total / cfg.tamanho));
  const esperas = blocos - 1;
  const minutosEnviando = porHora > 0 ? (total / porHora) * 60 : 0;
  return { blocos, esperas, minutos: Math.round(minutosEnviando + esperas * cfg.esperaMinutos) };
}
