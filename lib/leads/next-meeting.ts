/**
 * "Qual compromisso mostrar no card do Kanban" — pura, testável sem banco.
 *
 * Desde a agenda por sala (0200/0201) a fonte é `calendar_appointments`, a
 * MESMA tabela que a Agenda desenha — não mais a timeline do negócio
 * (`meeting_scheduled`/`meeting_outcome`). Pedido do dono do produto:
 * marcou pela Agenda, aparece no Kanban; marcou pelo Kanban, aparece na
 * Agenda; um lugar só, sem marcar duas vezes. Ler da timeline deixava três
 * buracos: cancelar na Agenda não emitia nada (o card seguia mostrando a
 * visita cancelada); negócio criado DEPOIS do agendamento não tinha atividade
 * (o card ficava vazio); e o status (Confirmado/Não confirmado) não existia lá.
 *
 * O vínculo é pelo CONTATO do negócio — é assim que o compromisso nasce
 * (`calendar_appointments.contact_id`), com ou sem negócio aberto.
 *
 * Usada pelo enriquecimento do board (`app/api/v1/pipelines/[id]/board/
 * route.ts`, `withNextMeetings`).
 */
import type { StatusDoCompromisso } from "@/lib/agenda/tipos";

export interface CompromissoDoContato {
  contact_id: string;
  starts_at: string;
  ends_at: string;
  status: StatusDoCompromisso;
}

export interface ProximaReuniao {
  starts_at: string;
  status: StatusDoCompromisso;
}

/** Status que ainda são "visita a acontecer" — compareceu/faltou/cancelou já resolveram. */
const EM_ABERTO: readonly StatusDoCompromisso[] = ["pending", "confirmed", "declined"];

/** Quanto tempo depois do início um compromisso sem desfecho ainda aparece (para a recepção registrar presença). */
const JANELA_SEM_DESFECHO_MS = 24 * 60 * 60_000;

/**
 * Por contato: o próximo compromisso em aberto que ainda não terminou; se não
 * houver, o mais recente que começou nas últimas 24h e ninguém marcou
 * compareceu/faltou — a visita de hoje de manhã continua no card até alguém
 * registrar o desfecho.
 */
export function proximoCompromissoPorContato(rows: CompromissoDoContato[], agora: Date): Map<string, ProximaReuniao> {
  const agoraMs = agora.getTime();
  const futuro = new Map<string, CompromissoDoContato>();
  const recente = new Map<string, CompromissoDoContato>();

  for (const r of rows) {
    if (!EM_ABERTO.includes(r.status)) continue;
    const inicio = new Date(r.starts_at).getTime();
    const fim = new Date(r.ends_at).getTime();
    if (fim >= agoraMs) {
      const atual = futuro.get(r.contact_id);
      if (!atual || inicio < new Date(atual.starts_at).getTime()) futuro.set(r.contact_id, r);
    } else if (agoraMs - inicio <= JANELA_SEM_DESFECHO_MS) {
      const atual = recente.get(r.contact_id);
      if (!atual || inicio > new Date(atual.starts_at).getTime()) recente.set(r.contact_id, r);
    }
  }

  const porContato = new Map<string, ProximaReuniao>();
  for (const [contato, r] of recente) porContato.set(contato, { starts_at: r.starts_at, status: r.status });
  for (const [contato, r] of futuro) porContato.set(contato, { starts_at: r.starts_at, status: r.status });
  return porContato;
}
