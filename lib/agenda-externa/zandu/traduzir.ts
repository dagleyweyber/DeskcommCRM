/**
 * Aviso (webhook) do Zandu → agendamentos da Agenda. Função pura.
 *
 * O Zandu não documenta o corpo do webhook. Este é o formato MEDIDO no 1º aviso real
 * (RevitaFio Mossoró, 2026-11-22):
 *
 *   { data: [ { appointmentId, start, end, status: "agendamento_criado", notes,
 *               personId, scheduleId, companyId, items: [{ serviceId, … }], … } ],
 *     event: { lastEvent: "agendamento_criado", content: "Avaliação ", personId,
 *              externalId: <appointmentId>, companyId, … },
 *     param: "" }
 *
 * O que o aviso NÃO traz: nome e celular da pessoa, nome do serviço, nome da agenda —
 * só os códigos. Quem processa completa pela API (ver `avisos.ts`): `/persons/{id}`,
 * `/services`, `/schedulers/schedules`. Aqui só se lê o que veio e se guardam os códigos.
 *
 * Datas em UTC com "Z". `data` é lista: um aviso pode trazer mais de um agendamento.
 */
import type { AgendamentoImportado } from "../belle/traduzir";
import {
  fimOuPadrao,
  instante,
  nomeDe,
  objeto,
  statusPorTexto,
  telefoneNoObjeto,
  texto,
  tipoDoServico,
  type AvisoTraduzido,
  type ItemDoAviso,
  type Objeto,
} from "../aviso-comum";

/** "agendamento_criado" → "Agendamento criado" (como aparece no detalhe da Agenda). */
export function statusLegivel(status: string): string {
  const s = status.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "";
}

/** "1 - Avaliação" → "Avaliação" (o catálogo do Zandu numera os serviços). */
export function nomeDoServico(nome: string): string {
  return nome.replace(/^\s*\d+\s*-\s*/, "").trim();
}

/**
 * O aviso de CONFIRMAÇÃO (medido 2026-11-23) vem sem `data`: só `event`, com o código
 * (`externalId`), o início (`externalDate`), a pessoa e o nome do serviço. Faltam fim e
 * agenda — quem processa busca o agendamento completo pela API. Esta função diz o código
 * a buscar quando o aviso veio assim.
 */
export function codigoSemDetalhe(payload: unknown): string | null {
  const corpo = objeto(payload);
  if (agendamentosDo(corpo).length > 0) return null;
  return texto(objeto(corpo?.event), "externalId") || null;
}

/** Os agendamentos do corpo: `data` (lista ou objeto), ou o próprio corpo. */
function agendamentosDo(corpo: Objeto | null): Objeto[] {
  const data = corpo?.data;
  if (Array.isArray(data)) return data.map(objeto).filter((o): o is Objeto => o !== null);
  const um = objeto(data) ?? objeto(corpo?.appointment);
  if (um) return [objeto(um.appointment) ?? um];
  return corpo && texto(corpo, "appointmentId") ? [corpo] : [];
}

function itensDeServico(ag: Objeto): Objeto[] {
  const itens = Array.isArray(ag.items) ? ag.items : Array.isArray(ag.services) ? ag.services : [];
  return itens.map(objeto).filter((o): o is Objeto => o !== null);
}

function traduzirUm(ag: Objeto, evento: string, conteudo: string): ItemDoAviso | null {
  const externalId = texto(ag, "appointmentId", "id");
  const inicio = instante(texto(ag, "start", "startDate", "startAt"), "utc");
  if (!externalId || !inicio) return null;
  // Horário bloqueado (indisponibilidade) não é paciente agendada.
  if (/bloque/i.test(nomeDe(ag.status) || evento)) return null;

  const pessoa = objeto(ag.person) ?? objeto(ag.customer);
  const servicos = itensDeServico(ag);
  const servicoIds = servicos.map((s) => texto(s, "serviceId")).filter(Boolean);
  // Nome do serviço só se o aviso trouxer; senão o processamento busca no catálogo.
  const nomes = servicos
    .map((s) => nomeDe(s.service) || texto(s, "serviceName", "name"))
    .filter(Boolean)
    .map(nomeDoServico);
  // `event.content` ("Avaliação ") é ambíguo — no aviso medido era o nome do serviço E da
  // agenda. Só vale enquanto o catálogo não diz o nome pelo `serviceId`.
  const servico = nomes.join(", ") || nomeDoServico(conteudo);
  const removido = /delet|remov|exclu/i.test(evento) || ag.deleted === true;
  const statusExterno = removido ? "Removido" : statusLegivel(nomeDe(ag.status) || evento);
  const notas = texto(ag, "notes", "observation");
  const duracao = Number(ag.durationMinutes ?? ag.duration);
  const agenda = objeto(ag.schedule);

  const item: AgendamentoImportado = {
    externalId,
    startsAt: inicio,
    endsAt: fimOuPadrao(
      inicio,
      instante(texto(ag, "end", "endDate", "endAt"), "utc"),
      Number.isFinite(duracao) ? duracao : null,
    ),
    status: removido ? "cancelled" : statusPorTexto(statusExterno),
    statusExterno,
    // A "agenda" do Zandu (Sala 1, Avaliação…) é o que ocupa o horário: vira a sala da Agenda.
    salaCodigo: texto(ag, "scheduleId") || texto(agenda, "scheduleId", "id") || null,
    salaNome: nomeDe(agenda) || texto(ag, "scheduleName", "scheduleLabel"),
    titulo: (servico || "Agendamento").slice(0, 300),
    notas: notas ? notas.slice(0, 2000) : null,
    cliente: {
      codigo: texto(ag, "personId") || texto(pessoa, "personId", "id"),
      nome: texto(ag, "personName") || nomeDe(pessoa),
      celular: texto(ag, "personPhone") || telefoneNoObjeto(pessoa),
      ddi: null,
      camposExtras: [],
    },
    tipo: tipoDoServico(servico.split(",")[0] ?? ""),
  };
  return {
    item,
    pessoaId: item.cliente.codigo || null,
    servicoIds: nomes.length ? [] : servicoIds,
  };
}

export function traduzirAvisoDoZandu(payload: unknown): AvisoTraduzido {
  const corpo = objeto(payload);
  const meta = objeto(corpo?.event);
  const evento = texto(meta, "lastEvent", "status") || texto(corpo, "event", "type", "action");
  const conteudo = texto(meta, "content");
  const conta = texto(meta, "companyId") || null;
  const itens = agendamentosDo(corpo)
    .map((ag) => traduzirUm(ag, evento, conteudo))
    .filter((i): i is ItemDoAviso => i !== null);
  if (itens.length === 0) {
    return {
      evento,
      externalId: texto(meta, "externalId") || null,
      conta,
      itens: [],
      motivo: "aviso sem código ou sem data de agendamento",
    };
  }
  return {
    evento,
    externalId: itens[0]!.item.externalId,
    conta: conta || texto(agendamentosDo(corpo)[0], "companyId") || null,
    itens,
    motivo: null,
  };
}
