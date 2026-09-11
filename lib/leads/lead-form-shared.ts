/**
 * Compartilhado entre NewLeadDialog (criação) e LeadFieldsForm (edição no
 * dossiê) — os dois formulários de lead do kanban. Client-safe de propósito
 * (sem import de lib/webhooks/inbound.ts, que carrega dependências de servidor).
 */

/** Sentinela do <Select>: shadcn não aceita value="" num SelectItem. */
export const NO_OWNER = "__sem_atendente__";

/** Origens ofertadas nos seletores manuais — "manual" cobre quem só quer registrar sem apontar canal. */
export const LEAD_SOURCES = [
  { value: "manual", label: "Manual (sem canal específico)" },
  { value: "meta_ads", label: "Meta Ads" },
  { value: "instagram", label: "Instagram" },
  { value: "google_ads", label: "Google Ads" },
  { value: "indicacao", label: "Indicação" },
  { value: "parceria", label: "Parceria" },
] as const;

/**
 * Rótulo de exibição pra QUALQUER origem que apareça num lead — supraconjunto
 * de `LEAD_SOURCES`: cobre também as que só o SISTEMA atribui, nunca
 * oferecidas num seletor manual (`nascimento-do-lead.ts` grava "whatsapp"
 * quando a demanda nasce sozinha de uma conversa; `create-or-move-lead.ts`
 * grava "automation" quando é regra/IA). `source` é vocabulário aberto (`text`,
 * não enum) — uma origem sem entrada aqui aparece com o valor cru, nunca
 * quebra o filtro do Kanban.
 */
const SOURCE_LABELS: Record<string, string> = {
  ...Object.fromEntries(LEAD_SOURCES.map((s) => [s.value, s.label])),
  whatsapp: "WhatsApp",
  automation: "Automação",
};

export function sourceLabel(value: string): string {
  return SOURCE_LABELS[value] ?? value;
}

/**
 * Normaliza telefone BR pra E.164. Espelha `normalizePhoneBR` de
 * lib/webhooks/inbound.ts (não importado de lá de propósito: aquele arquivo
 * carrega dependências de servidor que não devem ir pro bundle do client).
 */
export function normalizePhoneBR(raw: string): string | null {
  if (!raw.trim()) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) {
    return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
  }
  if (digits.length === 12 || digits.length === 13) {
    return digits.startsWith("55") ? `+${digits}` : null;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  return null;
}
