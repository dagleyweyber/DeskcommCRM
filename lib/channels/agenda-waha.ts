/**
 * Lê do WAHA a agenda de uma sessão: quem está salvo no celular e quem só
 * conversou. É a metade do WAHA de `ChannelAdapter.listAddressBook` — o adapter
 * só embrulha isto, e a rota nunca o vê.
 *
 * A parte pura (`consolidarAgenda`) não toca rede, para o formato ser testável
 * sem WAHA.
 */
import {
  WahaStoreDesligadoError,
  type WahaChatCru,
  type WahaClient,
  type WahaContatoCru,
} from "@/lib/waha/client";

import {
  AgendaGrandeDemaisError,
  AgendaIndisponivelError,
  LIMITE_DA_AGENDA,
  type AgendaDoCanal,
  type ContatoDaAgenda,
} from "./agenda";

/** Itens por página; o teto de páginas abaixo impede laço infinito. */
const PAGINA = 1000;
const MAX_PAGINAS = Math.ceil(LIMITE_DA_AGENDA / PAGINA) + 1;

const SUFIXOS_QUE_NAO_SAO_PESSOA = ["@g.us", "@broadcast", "@newsletter"];

function texto(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/**
 * `5581999999999@c.us` → `+5581999999999`. `pessoa: false` para o que não é uma
 * pessoa (grupo, lista de transmissão, canal); `telefone: null` com `pessoa: true`
 * para id opaco (`@lid`) que ainda não tem número.
 */
function telefoneDoId(id: string | undefined): { pessoa: boolean; telefone: string | null } {
  if (!id) return { pessoa: false, telefone: null };
  if (SUFIXOS_QUE_NAO_SAO_PESSOA.some((s) => id.endsWith(s))) return { pessoa: false, telefone: null };
  if (id.endsWith("@lid")) return { pessoa: true, telefone: null };
  // `:12` depois do número é o aparelho (multi-device), não faz parte dele.
  const digitos = (id.split("@")[0] ?? "").split(":")[0]?.replace(/\D/g, "") ?? "";
  return { pessoa: true, telefone: digitos.length >= 8 ? `+${digitos}` : null };
}

/**
 * Junta os contatos salvos e as conversas numa lista sem repetição por telefone.
 *
 * "Salvo" é o que o WAHA diz (`isMyContact`) ou, na falta do campo, ter nome na
 * agenda. Quem só aparece nas conversas entra como não salvo.
 */
export function consolidarAgenda(contatos: WahaContatoCru[], chats: WahaChatCru[]): AgendaDoCanal {
  const porTelefone = new Map<string, ContatoDaAgenda>();
  const semTelefone = new Set<string>();

  for (const c of contatos) {
    if (c.isGroup) continue;
    const { pessoa, telefone } = telefoneDoId(c.id);
    if (!pessoa) continue;
    if (!telefone) {
      if (c.id) semTelefone.add(c.id);
      continue;
    }
    const nomeNaAgenda = texto(c.name);
    const pushname = texto(c.pushname);
    const salvo = c.isMyContact === true || (c.isMyContact == null && nomeNaAgenda !== null);
    porTelefone.set(telefone, {
      nome: salvo ? (nomeNaAgenda ?? pushname) : (pushname ?? nomeNaAgenda),
      telefone,
      salvo,
      nome_no_whatsapp: pushname,
    });
  }

  for (const ch of chats) {
    const { pessoa, telefone } = telefoneDoId(ch.id);
    if (!pessoa) continue;
    if (!telefone) {
      if (ch.id) semTelefone.add(ch.id);
      continue;
    }
    const existente = porTelefone.get(telefone);
    if (existente) {
      // O contato já diz se está salvo; a conversa só completa o nome que faltar.
      if (!existente.nome) existente.nome = texto(ch.name);
      continue;
    }
    const nome = texto(ch.name);
    porTelefone.set(telefone, { nome, telefone, salvo: false, nome_no_whatsapp: nome });
  }

  const linhas = [...porTelefone.values()].sort((a, b) =>
    (a.nome ?? "￿").localeCompare(b.nome ?? "￿", "pt-BR", { sensitivity: "base" }),
  );
  return { linhas, sem_telefone: semTelefone.size };
}

/** Lê todas as páginas de uma lista; para quando acaba, quando repete ou ao passar do teto. */
async function lerTudo<T extends { id?: string }>(
  pagina: (p: { limit: number; offset: number }) => Promise<T[]>,
): Promise<T[]> {
  const todos: T[] = [];
  let primeiroDaAnterior: string | undefined;
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const itens = await pagina({ limit: PAGINA, offset: i * PAGINA });
    if (itens.length === 0) return todos;
    // Se o WAHA ignorar o `offset`, a mesma página volta para sempre.
    if (i > 0 && itens[0]?.id !== undefined && itens[0].id === primeiroDaAnterior) return todos;
    primeiroDaAnterior = itens[0]?.id;
    todos.push(...itens);
    if (todos.length > LIMITE_DA_AGENDA) throw new AgendaGrandeDemaisError();
    if (itens.length < PAGINA) return todos;
  }
  throw new AgendaGrandeDemaisError();
}

/** Lê do WAHA a agenda completa da sessão. */
export async function carregarAgendaDaSessao(
  waha: Pick<WahaClient, "listContacts" | "listChatsOverview">,
  sessao: string,
): Promise<AgendaDoCanal> {
  try {
    const contatos = await lerTudo((p) => waha.listContacts(sessao, p));
    const chats = await lerTudo((p) => waha.listChatsOverview(sessao, p));
    return consolidarAgenda(contatos, chats);
  } catch (err) {
    // Termo neutro para fora do seam: quem chama não conhece o WAHA.
    if (err instanceof WahaStoreDesligadoError) {
      throw new AgendaIndisponivelError("armazenamento_desligado");
    }
    throw err;
  }
}
