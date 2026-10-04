/**
 * Capacidades da AGENDA (núcleo, Fase 1 — sem Google Calendar).
 *
 * Ver o cabeçalho de `funil.ts`: este texto fala com o HUMANO que configura
 * o agente. O que o MODELO lê é a `description` do handler
 * (`lib/mcp/tools/agendamento.ts`), sem cópia aqui.
 */
import { declararTools } from "./tipos";

export const TOOLS_AGENDA = declararTools([
  {
    name: "crm_list_event_types",
    category: "read",
    rotulo: "Listar tipos de compromisso",
    explicacao: "Mostra os tipos de compromisso configurados (ex.: 'Avaliação', 'Consulta de retorno'), com a duração de cada um.",
    oQueToca: "Agenda",
    risco: "seguro",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_get_available_slots",
    category: "read",
    rotulo: "Ver horários livres",
    explicacao: "Consulta quais horários estão realmente livres pra marcar um compromisso, no mesmo cálculo que a tela da Agenda usa.",
    oQueToca: "Agenda",
    risco: "seguro",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_book_appointment",
    category: "write",
    rotulo: "Marcar compromisso",
    explicacao: "Marca um compromisso com o contato num horário livre — o mesmo horário que a tela mostraria.",
    oQueToca: "Agenda",
    risco: "atencao",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_reschedule_appointment",
    category: "write",
    rotulo: "Remarcar compromisso",
    explicacao: "Move um compromisso existente pra um novo horário livre, mantendo o histórico do anterior.",
    oQueToca: "Agenda",
    risco: "atencao",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_cancel_appointment",
    category: "write",
    rotulo: "Cancelar compromisso",
    explicacao: "Cancela um compromisso marcado — o horário volta a ficar disponível na hora.",
    oQueToca: "Agenda",
    risco: "critico",
    pacotes: ["atender", "vender"],
  },
]);
