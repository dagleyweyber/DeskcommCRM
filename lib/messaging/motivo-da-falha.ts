/**
 * O motivo que a tela, a campanha e a automação mostram quando UMA mensagem não saiu.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 * Os despachantes gravavam sempre a mesma frase — "mensagem ficou em 'failed' — canal
 * indisponível no momento do envio" — para QUALQUER falha. Na campanha de teste da
 * B'Laser Parnamirim o canal estava de pé (`WORKING`) e o motivo real era outro:
 * `template_missing_values: espera 3 valor(es) — falta: 1, 2, 3`. A frase genérica
 * mandava o operador procurar o problema no lugar errado.
 *
 * O envio já grava o motivo na linha da mensagem (`error_message`). O despachante só
 * precisa devolvê-lo. A frase antiga fica como reserva para o caso em que não há motivo
 * (a mensagem ficou na fila e nenhum erro foi gravado).
 *
 * ─── Falha de ENTREGA (assíncrona) ──────────────────────────────────────────
 * Quando a Meta aceita o envio (devolve um `wamid`) e depois falha a entrega, o motivo
 * chega no webhook de status e vai para `metadata.failure_code`/`failure_reason`
 * (`lib/channels/meta/process-events.ts`) — `error_message` fica nulo. Foi o caso da
 * B'Laser Parnamirim em 2026-10-27: a conversa mostrava "Falhou" e, ao passar o mouse,
 * "Erro desconhecido", com o motivo (forma de pagamento inválida na conta do WhatsApp
 * Business) gravado e sem ninguém ler. A tela agora lê os dois lugares.
 */
export interface MensagemParaMotivo {
  status: string;
  error_message?: string | null;
  error_code?: string | null;
  metadata?: Record<string, unknown> | null;
}

const LIMITE = 500;

/**
 * Códigos de erro da Meta que o operador consegue resolver sozinho, em português e
 * dizendo O QUE FAZER. O texto original da Meta vem em inglês e fala em "business
 * eligibility" — não diz a uma recepcionista onde clicar. Código fora desta lista
 * mostra o texto da Meta, que é melhor que nada.
 */
const EXPLICACAO_POR_CODIGO: Record<number, string> = {
  131042:
    "A conta do WhatsApp Business está sem forma de pagamento válida no Meta, então a mensagem não é entregue. " +
    "Cadastre ou corrija o cartão em Gerenciador do WhatsApp → Cobrança (billing) e envie de novo.",
  131047:
    "A conversa está fora da janela de 24h: só dá para enviar um modelo aprovado, não texto livre.",
  131026:
    "A mensagem não pôde ser entregue: o número pode não ter WhatsApp, ou o cliente não aceitou os termos mais recentes.",
  131048:
    "O Meta limitou os envios deste número por excesso de denúncias ou de mensagens. Aguarde antes de tentar de novo.",
  131049:
    "O Meta não entregou esta mensagem para este cliente para manter a qualidade das conversas. Não é erro do CRM; tente mais tarde ou use outro tipo de modelo.",
  130429: "Limite de envios por segundo do Meta atingido. Aguarde um pouco e tente de novo.",
  132000: "O número de valores enviados não bate com o que o modelo pede ({{1}}, {{2}}…). Confira as variáveis.",
  132001: "O modelo não existe, ou não está aprovado neste idioma, neste número.",
};

function codigoNumerico(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor.trim())) return Number(valor.trim());
  return null;
}

/**
 * O motivo da falha de entrega gravado pelo webhook de status da Meta, ou `null`.
 * Prefere a explicação em português para o código conhecido; sem ela, o texto da Meta.
 */
export function motivoDaEntrega(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const codigo = codigoNumerico(metadata.failure_code);
  if (codigo !== null && EXPLICACAO_POR_CODIGO[codigo]) return EXPLICACAO_POR_CODIGO[codigo]!;
  const bruto = typeof metadata.failure_reason === "string" ? metadata.failure_reason.trim() : "";
  if (bruto) return codigo !== null ? `${bruto} (código ${codigo})` : bruto;
  return null;
}

export function motivoDaFalha(message: MensagemParaMotivo): string {
  const real = message.error_message?.trim();
  if (real) return real.slice(0, LIMITE);
  const entrega = motivoDaEntrega(message.metadata);
  if (entrega) return entrega.slice(0, LIMITE);
  return `mensagem ficou em '${message.status}' — canal indisponível no momento do envio`;
}

/** O que a bolha da conversa mostra ao passar o mouse em "Falhou". */
export function motivoParaTela(message: Omit<MensagemParaMotivo, "status">): string {
  const real = message.error_message?.trim();
  if (real) return real;
  return motivoDaEntrega(message.metadata) ?? message.error_code ?? "Erro desconhecido";
}
