/**
 * "Ocupado" — função pura, sem banco: só decide se dois intervalos colidem.
 *
 * Fase 1 (sem Google Calendar): ocupado = só `calendar_appointments` com
 * status que ainda ocupa (ver `STATUS_QUE_OCUPAM` em tipos.ts — `pending`
 * ocupa por design, uma solicitação não confirmada ainda segura o horário).
 * Quando a Fase 2 trouxer o Google, os eventos externos entram na MESMA
 * lista de `IntervaloOcupado` antes de chegar aqui — esta função não muda.
 */
import type { IntervaloOcupado } from "./tipos";

/** Sobreposição estrita — toque na borda (fim de um = início do outro) NÃO conta como colisão. */
export function colide(a: IntervaloOcupado, b: IntervaloOcupado): boolean {
  return a.starts_at < b.ends_at && b.starts_at < a.ends_at;
}

/** O candidato colide com ALGUM intervalo ocupado? */
export function candidatoOcupado(candidato: IntervaloOcupado, ocupados: IntervaloOcupado[]): boolean {
  return ocupados.some((o) => colide(candidato, o));
}
