/**
 * O motivo que a campanha/automação grava quando o envio de UM destinatário não saiu.
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
 */
export interface MensagemParaMotivo {
  status: string;
  error_message?: string | null;
}

const LIMITE = 500;

export function motivoDaFalha(message: MensagemParaMotivo): string {
  const real = message.error_message?.trim();
  if (real) return real.slice(0, LIMITE);
  return `mensagem ficou em '${message.status}' — canal indisponível no momento do envio`;
}
