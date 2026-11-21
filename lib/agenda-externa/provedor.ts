/**
 * Sistemas de agenda externa. O id é o gravado em `calendar_integrations.provider`
 * e `calendar_appointments.external_provider` (CHECK da migration 0224).
 * Num arquivo à parte para quem só precisa do nome (ex.: a confirmação pelo WhatsApp,
 * o selo da Agenda) não arrastar o sincronizador inteiro.
 */
export const PROVEDORES_DE_AGENDA = ["belle", "uno", "zandu"] as const;
export type ProvedorDeAgenda = (typeof PROVEDORES_DE_AGENDA)[number];

/** O Belle — o único que o CRM relê (os outros avisam por webhook) e o único que recebe a confirmação de volta. */
export const PROVEDOR = "belle" as const;

const NOMES: Record<ProvedorDeAgenda, string> = { belle: "Belle", uno: "Uno", zandu: "Zandu" };

export function ehProvedorDeAgenda(valor: string | null | undefined): valor is ProvedorDeAgenda {
  return !!valor && (PROVEDORES_DE_AGENDA as readonly string[]).includes(valor);
}

/** "uno" → "Uno". Valor desconhecido volta como veio (nunca some da tela). */
export function nomeDoProvedor(provedor: string | null | undefined): string {
  return ehProvedorDeAgenda(provedor) ? NOMES[provedor] : (provedor ?? "");
}
