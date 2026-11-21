/**
 * Aviso (webhook) do Zandu → agendamento da Agenda. Função pura.
 *
 * ⚠ O Zandu NÃO documenta o corpo do webhook (https://api.zandu.com.br/docs só diz
 * que é um JSON por evento, assinado em Conta > Dispositivos e API). Este tradutor
 * lê os nomes que a própria API usa no agendamento (`appointmentId`, `start`,
 * `durationMinutes`, `personId`/`personPhone`/`personName`, `scheduleId`, `items`
 * com `serviceId`) e as variações comuns, e aceita o agendamento no topo do corpo
 * ou dentro de `appointment`/`data`. Todo aviso fica guardado cru em
 * `calendar_integration_events`: o 1º aviso real confirma (ou corrige) este mapa.
 *
 * Datas: a API do Zandu trabalha em UTC; data sem fuso é lida como UTC.
 */
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
  type Objeto,
} from "../aviso-comum";

/** O agendamento dentro do corpo: no topo ou embrulhado. */
function agendamentoDo(corpo: Objeto | null): Objeto | null {
  for (const chave of ["appointment", "data", "payload", "object"]) {
    const dentro = objeto(corpo?.[chave]);
    if (dentro) return objeto(dentro.appointment) ?? dentro;
  }
  return corpo;
}

function servicoDe(ag: Objeto): string {
  const itens = Array.isArray(ag.items) ? ag.items : Array.isArray(ag.services) ? ag.services : [];
  const nomes = itens
    .map((i) => {
      const o = objeto(i);
      return nomeDe(o?.service) || texto(o, "serviceName", "name", "nome");
    })
    .filter(Boolean);
  return nomes.length ? nomes.join(", ") : nomeDe(ag.service) || texto(ag, "serviceName");
}

export function traduzirAvisoDoZandu(payload: unknown): AvisoTraduzido {
  const corpo = objeto(payload);
  const evento = texto(corpo, "event", "type", "action", "eventType", "topic");
  const ag = agendamentoDo(corpo);
  const externalId = texto(ag, "appointmentId", "id", "_id");
  const inicio = instante(texto(ag, "start", "startDate", "startAt", "start_at", "date", "datetime"), "utc");
  if (!ag || !externalId || !inicio) {
    return { evento, externalId: externalId || null, conta: null, item: null, motivo: "aviso sem código ou sem data de agendamento" };
  }

  const pessoa = objeto(ag.person) ?? objeto(ag.customer) ?? objeto(ag.client);
  const removido = /delet|remov|exclu/i.test(evento) || ag.deleted === true || ag.removed === true;
  const statusExterno = removido ? "Removido" : nomeDe(ag.status) || nomeDe(ag.situation) || (/cancel/i.test(evento) ? "Cancelado" : /confirm/i.test(evento) ? "Confirmado" : "");
  const agenda = objeto(ag.schedule) ?? objeto(ag.scheduler);
  const servico = servicoDe(ag);
  const notas = texto(ag, "notes", "observation", "comments");
  const duracao = Number(ag.durationMinutes ?? ag.duration);

  return {
    evento,
    externalId,
    conta: texto(corpo, "companyId", "accountId", "company") || null,
    pessoaId: texto(ag, "personId") || texto(pessoa, "personId", "id") || null,
    motivo: null,
    item: {
      externalId,
      startsAt: inicio,
      endsAt: fimOuPadrao(inicio, instante(texto(ag, "end", "endDate", "endAt", "end_at"), "utc"), Number.isFinite(duracao) ? duracao : null),
      status: removido ? "cancelled" : statusPorTexto(statusExterno),
      statusExterno,
      // A "agenda" do Zandu (profissional/sala) é o que ocupa o horário: vira a sala da Agenda.
      salaCodigo: texto(agenda, "scheduleId", "id") || texto(ag, "scheduleId") || null,
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
    },
  };
}
