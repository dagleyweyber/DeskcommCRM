/**
 * Consulta `.in(coluna, ids)` em LOTES, para a URL nunca passar do limite.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 * Achado ao vivo (B'laser Caruaru, 2026-10-27): o Kanban da clínica falhava com
 * "Erro ao carregar pipeline: TypeError: fetch failed" enquanto os de todos os
 * outros clientes carregavam. O `.in()` do supabase-js vai na URL do GET
 * (`?lead_id=in.(id1,id2,…)`), e cada UUID gasta 37 caracteres. Com ~400 leads a
 * URL passa de ~15 KB e o `fetch` do servidor morre com `UND_ERR_HEADERS_OVERFLOW`
 * (medido da VPS contra o Supabase: 389 ids → 200; 420 ids → falha, a 15,6 KB).
 * O funil da Caruaru tinha 397 leads — na beirada — e o limite não avisa antes:
 * o quadro funciona até o dia em que o funil cresce mais um pouco.
 *
 * A biblioteca devolve esse erro como `{ message: "TypeError: fetch failed" }`, sem
 * dizer que o problema é o tamanho da URL, e o handler só repassa a mensagem. Por
 * isso o sintoma parecia "o CRM está lento" e não "a consulta é grande demais".
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 * Lista de ids que CRESCE com os dados do cliente (leads, contatos) nunca vai
 * inteira num `.in()`. Esta função parte a lista em lotes de `IDS_POR_LOTE`
 * (150 ids ≈ 5,6 KB de URL, folga de ~2,5x sobre o limite medido) e junta as
 * linhas. Os lotes saem em paralelo — o quadro já era de poucas idas ao banco e
 * não deve virar fila.
 *
 * A ordem entre lotes não é garantida. Quem depende de ordem (a conversa mais
 * recente do contato, a reunião mais recente do lead) está seguro porque cada id
 * pertence a UM lote só e a ordem DENTRO do lote é a do `order()` da consulta;
 * quem ordenava a lista inteira para depois pegar "a primeira de cada contato"
 * continua certo, pois os registros de um mesmo contato nunca se separam.
 */

/** Ids por consulta. 150 × 37 caracteres ≈ 5,6 KB; o limite medido é ~15 KB. */
export const IDS_POR_LOTE = 150;

export function emLotes<T>(itens: readonly T[], tamanho: number = IDS_POR_LOTE): T[][] {
  if (!Number.isInteger(tamanho) || tamanho < 1) {
    throw new Error(`tamanho de lote inválido: ${tamanho}`);
  }
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

interface Resposta<R> {
  data: R[] | null;
  error: { message: string } | null;
}

/**
 * Roda `consulta` uma vez por lote de `ids` e junta as linhas. Falhou um lote, a
 * chamada inteira falha: resultado parcial viraria um quadro com cartões sem
 * conversa ou sem score, sem ninguém saber que faltou dado.
 */
export async function consultaEmLotes<R>(
  ids: readonly string[],
  consulta: (lote: string[]) => PromiseLike<Resposta<R>>,
  tamanho: number = IDS_POR_LOTE,
): Promise<{ data: R[]; error: { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };

  const respostas = await Promise.all(emLotes(ids, tamanho).map((lote) => consulta(lote)));

  const linhas: R[] = [];
  for (const resposta of respostas) {
    if (resposta.error) return { data: [], error: resposta.error };
    if (resposta.data) linhas.push(...resposta.data);
  }
  return { data: linhas, error: null };
}
