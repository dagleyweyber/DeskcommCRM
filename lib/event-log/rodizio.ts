/**
 * Rodízio por organização — justiça entre inquilinos na fila de eventos.
 *
 * ## O defeito que faz este arquivo existir
 *
 * O drain pegava "as N linhas mais antigas" GLOBALMENTE (`order by created_at
 * limit 50`), sem nenhuma noção de organização. Com 4 ou 5 clínicas isso passa
 * despercebido. Com 50, uma clínica em rajada (disparo de campanha, enxurrada
 * de inbound depois de um anúncio) enche a fila com milhares de eventos mais
 * ANTIGOS que os das outras — e passa a consumir 100% de cada tick até a
 * própria fila esvaziar. As outras 49 esperam.
 *
 * O sintoma delas é exatamente o que motivou esta correção: "o CRM está
 * lento" — sem nada de errado no CRM delas, só uma vizinha barulhenta na
 * frente da fila. É o "noisy neighbor", o modo de falha clássico de sistema
 * multi-inquilino que trata a fila como uma só.
 *
 * ## O que esta função garante (e o que ela NÃO garante)
 *
 * GARANTE: toda organização com trabalho pendente é servida em TODO tick, não
 * "quando chegar a vez dela". Uma clínica com 1 evento não espera a clínica
 * com 10.000 terminar.
 *
 * PRESERVA: a ordem DENTRO de cada organização continua a mais antiga
 * primeiro. Isso é o que importa de verdade — `lead.created` antes de
 * `lead.stage_changed` do mesmo negócio. Ordem ENTRE organizações nunca
 * significou nada: são bancos de dados logicamente separados por RLS.
 *
 * NÃO GARANTE: nada sobre prioridade de evento. Rodízio é justiça, não
 * prioridade — quem precisar de "este tipo passa na frente" precisa de outro
 * mecanismo, não deste.
 *
 * ## Por que em memória, e não em SQL
 *
 * A alternativa seria `row_number() over (partition by organization_id)` no
 * banco. Ficaria mais caro exatamente onde não pode ficar: a janela de
 * ordenação roda no Postgres, que é o recurso escasso (o incidente que
 * originou esta correção foi Disk IO em 100%). Aqui a seleção já veio do
 * banco por um índice que existe; intercalar é um laço sobre algumas centenas
 * de linhas em memória no `app`, que tem CPU sobrando. Mover trabalho do
 * recurso escasso para o abundante.
 */

/**
 * Intercala as linhas por organização, em rodízio, preservando a ordem de
 * chegada dentro de cada uma.
 *
 * `linhas` deve vir JÁ ordenada (mais antiga primeiro) — a ordem de chegada é
 * que define tanto a fila interna de cada organização quanto qual delas abre
 * cada rodada (desempate a favor de quem esperou mais).
 */
export function intercalaPorOrganizacao<T extends { organization_id: string }>(
  linhas: readonly T[],
  teto: number,
): T[] {
  if (teto <= 0) return [];

  // Map preserva ordem de inserção: a organização cujo evento mais antigo
  // apareceu primeiro abre cada rodada. Determinístico — dá para testar.
  const filas = new Map<string, T[]>();
  for (const linha of linhas) {
    const fila = filas.get(linha.organization_id);
    if (fila) fila.push(linha);
    else filas.set(linha.organization_id, [linha]);
  }

  const saida: T[] = [];
  const todas = [...filas.values()];
  for (let rodada = 0; saida.length < teto; rodada++) {
    let serviuAlguem = false;
    for (const fila of todas) {
      const linha = fila[rodada];
      if (linha === undefined) continue;
      saida.push(linha);
      serviuAlguem = true;
      if (saida.length >= teto) break;
    }
    // Rodada inteira sem servir ninguém = todas as filas acabaram. Sem esta
    // guarda o laço roda para sempre quando há menos linhas que `teto`.
    if (!serviuAlguem) break;
  }
  return saida;
}
