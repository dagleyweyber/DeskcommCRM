/**
 * Resolve as variáveis de um template PARA UM destinatário — chamada uma vez
 * por destinatário, na criação da campanha (não em tempo de envio). O
 * despachante lê `resolved_values` já pronto; não precisa saber nada de
 * contato.
 *
 * A CHAVE (`slotKey`) é a mesma que `lib/channels/meta/build-components.ts`
 * já usa pro envio de um template só — endereço + posição, não `{{n}}` cru,
 * porque um corpo e um botão podem ter os dois um `{{1}}` cada.
 */
export type VariableSource =
  | { kind: "fixed"; value: string }
  | { kind: "contact_name" }
  | { kind: "contact_first_name" };

export type VariableMapping = Record<string, VariableSource>;

export interface RecipientForResolution {
  displayName: string;
}

function primeiroNome(nomeCompleto: string): string {
  return nomeCompleto.trim().split(/\s+/)[0] ?? nomeCompleto;
}

export function resolveValuesForRecipient(
  mapping: VariableMapping,
  recipient: RecipientForResolution,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slotKey, source] of Object.entries(mapping)) {
    switch (source.kind) {
      case "fixed":
        out[slotKey] = source.value;
        break;
      case "contact_name":
        out[slotKey] = recipient.displayName;
        break;
      case "contact_first_name":
        out[slotKey] = primeiroNome(recipient.displayName);
        break;
    }
  }
  return out;
}
