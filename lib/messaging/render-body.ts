/**
 * O texto que vai em `messages.body` — só para exibição na conversa e para
 * satisfazer o schema de envio (`sendMessageSchema` exige `body` mesmo em
 * `type:"template"`). Quem decide o que a Meta manda de verdade é
 * `template_values`; isto é só o preview substituído, pra quem olhar a
 * conversa depois ver o que o cliente recebeu, não `{{1}}` cru.
 *
 * Neutro de propósito (`lib/messaging/`, não `lib/campaigns/`) — Campanhas
 * e Automações reaproveitam o mesmo, nenhuma delas é dona.
 *
 * Só troca `{{n}}` do CORPO — a mesma convenção de `slotKey` (prefixo vazio
 * pra endereço `body`, ver `lib/channels/meta/build-components.ts`) já
 * garante que as chaves aqui não colidem com header/botão.
 */
export function renderBodyWithValues(rawBody: string, values: Record<string, string>): string {
  return rawBody.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}
