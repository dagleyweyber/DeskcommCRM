/**
 * Thin WAHA send helper exposed for the agent runtime (S-13.08).
 *
 * The runtime uses `sendMessageHandler` for the production path (handles WAHA
 * dispatch + outbound message row + ack + retries), so this module is a small
 * convenience for direct callers (tests, smoke checks). Returns null when
 * WAHA env is not configured — callers must treat that as a noop, not error.
 */
import { getWahaClient } from "./client";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

export interface SendWahaInput {
  sessionName: string;
  chatId: string;
  text: string;
}

export interface ResolveWahaChatIdInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
  /** `contacts.wa_identity` (migration 0027): 'phone:+E164' | 'lid:<digits>' | null. */
  waIdentity: string | null | undefined;
  /**
   * `contacts.wa_lid` (migration 0122): só os dígitos do Linked ID, ou null.
   *
   * Existe separada de `waIdentity` por uma razão que custou uma correção
   * errada: `wa_identity` é GERADA com o telefone na frente, então o contato
   * @lid que ganha número passa a valer `phone:+55…` e o teste
   * `waIdentity.startsWith("lid:")` fica FALSO — exatamente para quem a regra
   * precisava valer. Ler o lid daqui é o que faz a ordem abaixo significar algo.
   */
  waLid?: string | null | undefined;
  /**
   * Nome da sessão WAHA — necessário para perguntar ao `check-exists` qual é
   * o chatId REAL do telefone (ver `resolveCanonicalPhoneChatId` abaixo).
   * `undefined`/sessão sem cliente configurado: cai direto no formato
   * ingênuo, mesmo comportamento de antes desta checagem existir.
   */
  sessionRef?: string | null | undefined;
}

/**
 * O chatId que o PRÓPRIO WhatsApp confirma para este telefone, via
 * `check-exists` — ou `null` quando não dá para perguntar ou ninguém
 * confirma.
 *
 * ─── Por que isto existe ─────────────────────────────────────────────────
 *
 * Achado ao vivo (Ads Pro Company, automação "Boas-vindas"): dois leads
 * novos receberam a mensagem marcada como `sent` — WAHA devolveu um id de
 * mensagem normal — mas o `ack` nunca saiu de 0 e nenhum webhook
 * `message.ack` chegou, enquanto a mesma sessão tinha histórico de 2
 * mil+ mensagens entregues sem problema. Causa: o telefone salvo
 * (`5584996321728`, 9º dígito) não é o endereço real da conta — o WhatsApp
 * indexa esse número pela forma de 8 dígitos (`558496321728@c.us`),
 * confirmado consultando `check-exists` direto. `${dígitos}@c.us` monta um
 * endereço bem formado que não é NINGUÉM — o envio "sai" e nunca chega.
 *
 * `phoneLookupVariants` já existe para BUSCA (nunca escrita) do mesmo
 * problema do lado de entrada — aqui ela gera os candidatos (original e,
 * quando aplicável, a contraparte com/sem o 9º dígito) e `check-exists`
 * decide qual é real. Tenta o original primeiro: é o caso comum (número já
 * correto), e evita trocar de endereço à toa quando os dois existirem.
 */
async function resolveCanonicalPhoneChatId(
  sessionRef: string | null | undefined,
  phoneNumber: string,
): Promise<string | null> {
  if (!sessionRef) return null;
  const client = getWahaClient();
  if (!client) return null;
  for (const candidate of phoneLookupVariants(phoneNumber)) {
    const chatId = await client.checkExists(sessionRef, candidate.replace(/\D/g, ""));
    if (chatId) return chatId;
  }
  return null;
}

/**
 * O endereço WAHA de uma conversa 1:1 ou de grupo.
 *
 * ⚠️ **O `lid:` vem ANTES do telefone, e a ordem é a regra.**
 *
 * Até a migration 0122, contato @lid nunca tinha `phone_number` — o número era
 * descartado na ingestão —, então "telefone primeiro" nunca era exercido para
 * quem chegava por Linked ID. A 0122 passou a gravar o telefone que o WhatsApp
 * sempre mandou (`_data.key.remoteJidAlt`), e com a ordem antiga toda conversa
 * @lid viva mudaria de endereço de `@lid` para `@c.us` no envio seguinte.
 *
 * Trocar o canal de uma conversa que funciona é o pior defeito possível aqui: se
 * o `@c.us` não for endereçável — e para contato em modo privacidade ele
 * frequentemente não é —, paramos de responder o cliente, com a mensagem
 * marcada como enviada. O telefone entra para o CRM (identificar, buscar,
 * ligar, deduplicar); o ENVIO continua indo por onde a conversa veio.
 *
 * Contato sem `lid` (import, formulário, pedido) segue por `@c.us` como sempre
 * — e é justo esse ramo que `resolveCanonicalPhoneChatId` confere antes de
 * cair no formato ingênuo (ver seu próprio comentário acima).
 */
export async function resolveWahaChatId(input: ResolveWahaChatIdInput): Promise<string | null> {
  if (input.isGroup && input.groupChatId) return input.groupChatId;
  // `wa_lid` primeiro; `wa_identity` só como retaguarda para chamador que ainda
  // não lê a coluna nova (e que, por definição, é de contato sem telefone).
  if (input.waLid) return `${input.waLid}@lid`;
  if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice(4)}@lid`;
  if (input.phoneNumber) {
    const canonico = await resolveCanonicalPhoneChatId(input.sessionRef, input.phoneNumber);
    return canonico ?? `${input.phoneNumber.replace(/\D/g, "")}@c.us`;
  }
  return null;
}

export async function sendWAHA(input: SendWahaInput): Promise<unknown | null> {
  const client = getWahaClient();
  if (!client) return null;
  return client.sendMessage(input.sessionName, input.chatId, input.text);
}
