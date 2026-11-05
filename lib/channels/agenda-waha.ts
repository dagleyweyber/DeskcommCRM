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

/**
 * Marcas de direção e espaços de largura zero que o WhatsApp põe em volta de
 * nomes (medido: `‪(84) 99811‑9200‬`, `‎Glediatony`). O olho não vê, mas o CSV
 * guarda — e quebra a ordenação e a busca no Excel.
 *
 * Fica de FORA, de propósito, o U+200D (junção de largura zero) e o U+200C: o
 * primeiro é o que cola os emojis compostos (👨🏽‍🎨) — arrancá-lo desmonta o emoji
 * de quem o tem no nome. Só saem as marcas de direção, o espaço de largura zero e o BOM.
 */
const INVISIVEIS = /[​‎‏‪-‮⁦-⁩﻿]/g;

/** Só dígitos, sinais de telefone e a máscara que o WhatsApp usa (`∙`, `•`, `*`). */
const SO_TELEFONE = /^[\s+\d().\-‐-―∙•*]+$/;

/** Texto sem as marcas invisíveis, ou `null` se sobrar nada. */
function texto(v: string | null | undefined): string | null {
  const t = (v ?? "").replace(INVISIVEIS, "").trim();
  return t === "" ? null : t;
}

/**
 * Um NOME de verdade, ou `null`. O WhatsApp devolve como "nome" de quem foi
 * salvo só pelo número o próprio número — às vezes mascarado (`+55∙∙∙∙∙∙∙∙30`,
 * medido em 17 contatos). Isso não é nome: na planilha vira lixo (e a proteção
 * contra fórmula ainda põe um apóstrofo na frente). O telefone já está na coluna dele.
 */
function nomeDePessoa(v: string | null | undefined): string | null {
  const t = texto(v);
  return t === null || SO_TELEFONE.test(t) ? null : t;
}

/** Os dígitos de um id (`123456@lid` → `123456`). */
function digitosDoId(id: string): string {
  return id.split("@")[0] ?? "";
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
 * agenda — decidido ANTES de limpar o nome: quem foi salvo só pelo número tem
 * "nome" que é um número, e continua sendo contato salvo. Quem só aparece nas
 * conversas entra como não salvo.
 *
 * O apelido (`nome_no_whatsapp`) mora no contato por código (`@lid`), não no
 * contato com telefone: liga-se pelo `lid` que o contato com telefone carrega.
 *
 * `sem_telefone` conta as pessoas que o WhatsApp só identifica por código — quem
 * te escreveu sem estar na agenda, participantes de grupo. Nem o próprio WhatsApp
 * tem o número delas, então não há o que exportar; a conta existe para quem
 * exporta saber que a lista não é "todo mundo". Os códigos que pertencem a
 * alguém que JÁ saiu com telefone não entram: é a mesma pessoa duas vezes.
 */
export function consolidarAgenda(contatos: WahaContatoCru[], chats: WahaChatCru[]): AgendaDoCanal {
  const porTelefone = new Map<string, ContatoDaAgenda>();
  const semTelefone = new Set<string>();

  const apelidoPorLid = new Map<string, string>();
  const lidsDeQuemTemTelefone = new Set<string>();
  for (const c of contatos) {
    if (c.id?.endsWith("@lid")) {
      const apelido = nomeDePessoa(c.pushname);
      if (apelido) apelidoPorLid.set(digitosDoId(c.id), apelido);
    } else if (c.lid) {
      lidsDeQuemTemTelefone.add(digitosDoId(c.lid));
    }
  }
  const semNumero = (id: string) => {
    if (!lidsDeQuemTemTelefone.has(digitosDoId(id))) semTelefone.add(id);
  };

  for (const c of contatos) {
    if (c.isGroup) continue;
    const { pessoa, telefone } = telefoneDoId(c.id);
    if (!pessoa) continue;
    if (!telefone) {
      if (c.id) semNumero(c.id);
      continue;
    }
    const salvo = c.isMyContact === true || (c.isMyContact == null && texto(c.name) !== null);
    const nomeNaAgenda = nomeDePessoa(c.name);
    const apelido =
      nomeDePessoa(c.pushname) ?? (c.lid ? (apelidoPorLid.get(digitosDoId(c.lid)) ?? null) : null);
    porTelefone.set(telefone, {
      nome: salvo ? (nomeNaAgenda ?? apelido) : (apelido ?? nomeNaAgenda),
      telefone,
      salvo,
      nome_no_whatsapp: apelido,
    });
  }

  for (const ch of chats) {
    const { pessoa, telefone } = telefoneDoId(ch.id);
    if (!pessoa) continue;
    if (!telefone) {
      if (ch.id) semNumero(ch.id);
      continue;
    }
    const existente = porTelefone.get(telefone);
    if (existente) {
      // O contato já diz se está salvo; a conversa só completa o nome que faltar.
      if (!existente.nome) existente.nome = nomeDePessoa(ch.name);
      continue;
    }
    const nome = nomeDePessoa(ch.name);
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
