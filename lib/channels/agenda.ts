/**
 * A agenda de um canal na forma NEUTRA — sem o vocabulário de nenhum provider.
 *
 * É o que `ChannelAdapter.listAddressBook` devolve e o que a exportação consome.
 * Nada aqui é gravado: a agenda vive no transporte do canal, o CRM lê sob demanda
 * e descarta.
 */

export interface ContatoDaAgenda {
  /** Nome na agenda quando salvo; senão o nome que a pessoa usa no WhatsApp. */
  nome: string | null;
  telefone: string;
  salvo: boolean;
  nome_no_whatsapp: string | null;
}

export interface AgendaDoCanal {
  linhas: ContatoDaAgenda[];
  /** Identificadores opacos cujo telefone o canal ainda não revelou: não dá para exportar. */
  sem_telefone: number;
}

/** Teto de segurança: acima disso a rota recusa em vez de montar um CSV gigante em memória. */
export const LIMITE_DA_AGENDA = 200_000;

/**
 * O canal não tem uma agenda para ler AGORA. É estado do número, não falha:
 *  - `armazenamento_desligado`: a sessão nasceu sem guardar a agenda; só um novo
 *    pareamento (com a configuração certa) resolve.
 */
export class AgendaIndisponivelError extends Error {
  constructor(readonly motivo: "armazenamento_desligado") {
    super(`agenda_indisponivel:${motivo}`);
    this.name = "AgendaIndisponivelError";
  }
}

export class AgendaGrandeDemaisError extends Error {
  constructor() {
    super(`Mais de ${LIMITE_DA_AGENDA} contatos neste canal.`);
    this.name = "AgendaGrandeDemaisError";
  }
}
