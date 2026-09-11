/**
 * A rota (fora do seam, sem poder nomear provider) precisa saber UMA coisa
 * sobre o erro que `adapter.templates.create`/`.list` jogou: a PLATAFORMA
 * respondeu e recusou o conteúdo, ou a chamada nem voltou?
 *
 * ─── Por que isto importa pro status HTTP ──────────────────────────────────
 *
 * Achado ao vivo (RevitaFio Mossoró): as duas rotas de templates devolviam
 * 502 pra QUALQUER falha — inclusive a plataforma recusando um nome de
 * template inválido. O proxy da hospedagem intercepta 502/503/504 (são o
 * sinal de "gateway não alcançou o serviço") e troca o corpo pela PRÓPRIA
 * página de erro, engolindo a mensagem real que `template-ops.ts`/
 * `zernio/templates.ts` extraíram com tanto cuidado da API. A plataforma
 * RESPONDEU; isso é 422 (cliente pode corrigir e reenviar), não gateway.
 *
 * ─── Por que um helper aqui, e não a rota checando o texto ─────────────────
 *
 * Cada provider prefixa o erro com o PRÓPRIO nome (`meta_template_failed:`,
 * `zernio_template_failed:`) — e uma rota fora de `lib/channels/` não pode
 * nomear provider (invariante 1, `lint:channels`). O sufixo compartilhado
 * `_template_failed:` é o contrato neutro: todo `ChannelTemplateOps.create`
 * que lança por recusa da plataforma usa este sufixo, e só este arquivo,
 * dentro do seam, sabe o que ele significa.
 */
export function ehRecusaDaPlataforma(mensagemDeErro: string): boolean {
  return /_template_failed:/.test(mensagemDeErro);
}
