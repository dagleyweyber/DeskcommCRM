/**
 * "Qual a próxima visita/reunião PENDENTE de cada lead" — pura, testável sem
 * banco. `crm_lead_activities` não tem `status`; pendente é inferido pela
 * ORDEM: `meeting_scheduled`/`meeting_outcome` são dois tipos do MESMO fluxo
 * (reagendar é emitir de novo, registrar presença é emitir depois), e o
 * evento mais recente de qualquer um dos dois já responde a pergunta — se
 * for `meeting_outcome`, o agendamento mais novo já foi resolvido.
 *
 * Usada pelo enriquecimento do board (`app/api/v1/pipelines/[id]/board/
 * route.ts`, `withNextMeetings`) — extraída pra a lógica de correlação (não
 * a query) ser testável direto, mesmo padrão de `dateRangeCutoff` em
 * `lib/kanban/filters.ts`.
 */
export interface AtividadeDeReuniao {
  lead_id: string;
  type: string;
  payload: { scheduled_at?: string } | null;
}

/**
 * @param atividades JÁ ordenadas por `performed_at` DESCENDENTE (mais
 * recente primeiro) — quem chama (a query) garante a ordem; esta função só
 * pega a primeira vista de cada `lead_id`.
 */
export function proximasReunioesPorLead(atividades: AtividadeDeReuniao[]): Map<string, string> {
  const vistos = new Set<string>();
  const porLead = new Map<string, string>();
  for (const row of atividades) {
    if (vistos.has(row.lead_id)) continue;
    vistos.add(row.lead_id);
    if (row.type === "meeting_scheduled" && row.payload?.scheduled_at) {
      porLead.set(row.lead_id, row.payload.scheduled_at);
    }
  }
  return porLead;
}
