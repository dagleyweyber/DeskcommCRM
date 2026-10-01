/**
 * Vocabulário fechado de `crm_stages.meta_capi_event_name` (migration 0180) —
 * espelha `crm_stages_meta_capi_event_name_check`. Arquivo sem I/O de
 * propósito: é importado tanto por código de servidor (`lib/leads/
 * stage-operations.ts`, a rota de API) quanto por componente client
 * (`_stages.tsx`) — colocar isto dentro de `stage-operations.ts` arrastaria
 * `@/lib/audit`/Supabase pro bundle do navegador.
 */
export const EVENTOS_META_CAPI_DE_ETAPA = [
  "Schedule",
  "Lead",
  "CompleteRegistration",
  "InitiateCheckout",
  "Contact",
] as const;

export type EventoMetaCapiDeEtapa = (typeof EVENTOS_META_CAPI_DE_ETAPA)[number];

/** Rótulo em pt-BR pra tela — o nome técnico do evento Meta fica só como referência. */
export const ROTULO_DO_EVENTO_META_CAPI: Readonly<Record<EventoMetaCapiDeEtapa, string>> = {
  Schedule: "Agendamento (Schedule)",
  Lead: "Lead qualificado (Lead)",
  CompleteRegistration: "Cadastro concluído (CompleteRegistration)",
  InitiateCheckout: "Início de fechamento (InitiateCheckout)",
  Contact: "Contato direto (Contact)",
};
