/**
 * Aviso (webhook) do Uno → agendamento da Agenda. Função pura.
 *
 * Contrato documentado em https://readme.unobject.com.br/reference/webhook:
 *   { event: "APPOINTMENT_CREATED|UPDATED|REMOVED" | "ORDER_…", schema: "<empresa>",
 *     appointment: { id, startDate, endDate, observation, serviceSession,
 *                    status:{id,name}, customer:{id,name}, employee, room, service } }
 * Datas em ISO com o fuso da empresa. Venda (ORDER_*) não é agendamento: ignorada.
 *
 * ⚠ O Uno documenta o cliente só com `{ id, name }` — sem celular. O telefone é
 * procurado em qualquer campo do cliente (se o Uno mandar a mais, entra); sem ele
 * o agendamento não tem com quem casar e conta como "sem celular".
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
} from "../aviso-comum";

export function traduzirAvisoDoUno(payload: unknown): AvisoTraduzido {
  const corpo = objeto(payload);
  const evento = texto(corpo, "event");
  const conta = texto(corpo, "schema") || null;
  const ag = objeto(corpo?.appointment);
  if (!evento.startsWith("APPOINTMENT_") || !ag) {
    return { evento, externalId: null, conta, itens: [], motivo: "não é aviso de agendamento" };
  }
  const externalId = texto(ag, "id");
  const inicio = instante(texto(ag, "startDate"));
  if (!externalId || !inicio) {
    return {
      evento,
      externalId: externalId || null,
      conta,
      itens: [],
      motivo: "aviso sem código ou sem data",
    };
  }

  const removido = evento === "APPOINTMENT_REMOVED";
  const statusExterno = removido ? "Removido" : nomeDe(ag.status);
  const cliente = objeto(ag.customer);
  const sala = objeto(ag.room);
  const servico = nomeDe(ag.service);
  const observacao = texto(ag, "observation");

  return {
    evento,
    externalId,
    conta,
    motivo: null,
    itens: [
      {
        item: {
          externalId,
          startsAt: inicio,
          endsAt: fimOuPadrao(inicio, instante(texto(ag, "endDate"))),
          status: removido ? "cancelled" : statusPorTexto(statusExterno),
          statusExterno,
          salaCodigo: texto(sala, "id") || null,
          salaNome: nomeDe(sala),
          titulo: (servico || "Agendamento").slice(0, 300),
          notas: observacao ? observacao.slice(0, 2000) : null,
          cliente: {
            codigo: texto(cliente, "id"),
            nome: nomeDe(cliente),
            celular: telefoneNoObjeto(cliente),
            ddi: null,
            camposExtras: Object.keys(cliente ?? {}).filter((k) => !["id", "name"].includes(k)),
          },
          tipo: tipoDoServico(servico),
        },
      },
    ],
  };
}
