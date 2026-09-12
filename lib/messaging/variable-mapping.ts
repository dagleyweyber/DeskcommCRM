/**
 * Resolve as variáveis de um template PARA UM destinatário — usado por
 * Campanhas (disparo em massa, `lib/campaigns/dispatch.ts`) e por
 * Automações (`lib/automations/dispatch.ts`). Mora aqui, neutro, e não
 * dentro de `lib/campaigns/`: automação não é campanha, e "Automações
 * importa de dentro de Campanhas" seria a dependência ao contrário do que
 * o nome de cada pasta promete.
 *
 * A CHAVE (`slotKey`) é a mesma que `lib/channels/meta/build-components.ts`
 * já usa pro envio de um template só — endereço + posição, não `{{n}}`
 * cru, porque um corpo e um botão podem ter os dois um `{{1}}` cada.
 *
 * Campanhas resolve isto UMA VEZ por destinatário, na criação (lista
 * fechada, resolvida contra um snapshot). Automações resolve NA HORA do
 * envio — não existe destinatário fixo: a automação roda sobre quem quer
 * que apareça amanhã, e os slots `appointment_date`/`appointment_time`
 * só fazem sentido calculados no momento em que a ocorrência é
 * encontrada, nunca antes.
 */
export type VariableSource =
  | { kind: "fixed"; value: string }
  | { kind: "contact_name" }
  | { kind: "contact_first_name" }
  | { kind: "appointment_date" }
  | { kind: "appointment_time" };

export type VariableMapping = Record<string, VariableSource>;

export interface RecipientForResolution {
  displayName: string;
  /** ISO com offset — só presente quando o gatilho é de agendamento. */
  appointmentAt?: string;
}

function primeiroNome(nomeCompleto: string): string {
  return nomeCompleto.trim().split(/\s+/)[0] ?? nomeCompleto;
}

/** "14/03" — pt-BR, fuso fixo América/São_Paulo (mesma premissa de `lib/automation/throttle.ts`). */
function formataDataAgendamento(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}

/** "08:30" — pt-BR, mesmo fuso. */
function formataHoraAgendamento(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
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
      case "appointment_date":
        out[slotKey] = recipient.appointmentAt ? formataDataAgendamento(recipient.appointmentAt) : "";
        break;
      case "appointment_time":
        out[slotKey] = recipient.appointmentAt ? formataHoraAgendamento(recipient.appointmentAt) : "";
        break;
    }
  }
  return out;
}
