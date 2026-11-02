/**
 * Importação de contatos por planilha — as regras puras, sem banco nem DOM.
 *
 * Roda nos DOIS lados: no navegador para a prévia ("1.240 prontos, 12 com
 * problema") antes de qualquer envio, e no servidor, que refaz tudo — o
 * servidor nunca confia no que o navegador já normalizou.
 *
 * Importar contato NÃO cria lead: o objetivo é pôr a base no CRM com tag para
 * campanha (`lib/campaigns/audience.ts` lê `contacts.tags`). Lead é demanda
 * aberta; uma lista de clientes antigos não é.
 */
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { normalizePhoneBR } from "@/lib/leads/lead-form-shared";

/** Linhas por arquivo. Acima disso o navegador sofre na prévia e o operador deve dividir a base. */
export const MAX_LINHAS_POR_ARQUIVO = 20_000;
/** Linhas por chamada à API (e por chamada a `fn_importar_contatos`). */
export const LINHAS_POR_LOTE = 500;
export const MAX_TAGS = 10;
export const MAX_TAMANHO_TAG = 60;

export type CampoDoContato = "nome" | "telefone" | "email" | "tags";

/** Índice da coluna da planilha para cada campo; `null` = não importar. */
export type Mapeamento = Record<CampoDoContato, number | null>;

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const chave = (s: string) => semAcento(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Nomes de cabeçalho reconhecidos, já em forma de `chave()`. Ordem = preferência. */
const APELIDOS: Record<CampoDoContato, string[]> = {
  telefone: ["whatsapp", "celular", "telefone", "fone", "phone", "telefonecelular", "numero", "contato", "tel", "mobile"],
  nome: ["nome", "nomecompleto", "cliente", "name", "nomedocliente", "paciente", "razaosocial"],
  email: ["email", "mail", "correioeletronico"],
  tags: ["tags", "tag", "etiquetas", "etiqueta", "segmento", "grupo", "lista"],
};

/** Adivinha o mapeamento pelo cabeçalho. O operador confere e corrige na tela. */
export function detectarColunas(cabecalho: string[]): Mapeamento {
  const chaves = cabecalho.map(chave);
  const usado = new Set<number>();
  const achar = (campo: CampoDoContato): number | null => {
    for (const apelido of APELIDOS[campo]) {
      const exato = chaves.findIndex((k, i) => !usado.has(i) && k === apelido);
      if (exato >= 0) return exato;
    }
    for (const apelido of APELIDOS[campo]) {
      const contem = chaves.findIndex((k, i) => !usado.has(i) && k.length > 0 && k.includes(apelido));
      if (contem >= 0) return contem;
    }
    return null;
  };
  const m: Mapeamento = { telefone: null, nome: null, email: null, tags: null };
  for (const campo of ["telefone", "email", "nome", "tags"] as const) {
    const i = achar(campo);
    if (i !== null) usado.add(i);
    m[campo] = i;
  }
  return m;
}

export type MotivoDoProblema =
  | "sem_telefone"
  | "telefone_invalido"
  | "telefone_cientifico"
  | "duplicado_no_arquivo";

export const TEXTO_DO_MOTIVO: Record<MotivoDoProblema | "anonimizado" | "duplicado" | "bloqueado", string> = {
  sem_telefone: "Sem telefone",
  telefone_invalido: "Telefone inválido",
  telefone_cientifico:
    "Telefone em notação científica (ex.: 5,58E+12) — o Excel cortou os dígitos. Formate a coluna como Texto e exporte de novo.",
  duplicado_no_arquivo: "Mesmo telefone em outra linha do arquivo",
  anonimizado: "Contato anonimizado (LGPD) — não é reimportado",
  duplicado: "Criado por outro processo durante a importação",
  bloqueado: "Já pediu para não receber mensagens — fica fora das campanhas",
};

/**
 * Telefone da planilha → E.164, ou o motivo de não servir.
 *
 * Além do `normalizePhoneBR` de sempre: tira zeros à esquerda ("081 9…", hábito
 * de operadora) e reconhece a notação científica que o Excel cria em coluna
 * numérica — esse número perdeu dígitos e não tem conserto aqui.
 */
export function telefoneDaPlanilha(bruto: unknown): { e164: string } | { motivo: MotivoDoProblema } {
  const texto = String(bruto ?? "").trim();
  if (!texto) return { motivo: "sem_telefone" };
  if (/\d[.,]?\d*e\+?\d+/i.test(texto)) return { motivo: "telefone_cientifico" };
  const comMais = texto.startsWith("+");
  const limpo = comMais ? texto : texto.replace(/\D/g, "").replace(/^0+/, "");
  const e164 = normalizePhoneBR(limpo);
  return e164 ? { e164 } : { motivo: "telefone_invalido" };
}

export function normalizarTag(bruta: string): string {
  return bruta.replace(/\s+/g, " ").trim().slice(0, MAX_TAMANHO_TAG);
}

/** Uma célula de tags: "vip, laser; 2024" → ["vip", "laser", "2024"]. */
export function separarTags(celula: unknown): string[] {
  return String(celula ?? "")
    .split(/[,;|]/)
    .map(normalizarTag)
    .filter(Boolean);
}

/**
 * Reaproveita a grafia de uma tag que já existe quando a diferença é só caixa ou
 * acento. A campanha filtra por igualdade exata — "VIP" e "vip" seriam públicos
 * diferentes, e o operador descobriria só quando a campanha saísse pela metade.
 */
export function canonizarTag(tag: string, existentes: readonly string[]): string {
  const t = normalizarTag(tag);
  const k = chave(t);
  return existentes.find((e) => chave(e) === k) ?? t;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LinhaPronta {
  /** Número da linha NA PLANILHA (cabeçalho = 1), para o operador achar. */
  linha: number;
  telefone: string;
  nome: string | null;
  email: string | null;
  tags: string[];
}

export interface LinhaComProblema {
  linha: number;
  motivo: MotivoDoProblema;
  telefoneBruto: string;
  nome: string;
}

export interface Preparo {
  prontas: LinhaPronta[];
  problemas: LinhaComProblema[];
}

/**
 * Planilha crua (sem o cabeçalho) → linhas prontas e linhas com problema.
 *
 * Duplicata dentro do arquivo é comparada por VARIANTE do 9º dígito: a mesma
 * pessoa listada como "81 99184-0070" e "81 9184-0070" é uma pessoa só. Fica a
 * primeira ocorrência; as tags da linha repetida somam nela.
 */
export function prepararLinhas(
  linhas: readonly (readonly unknown[])[],
  m: Mapeamento,
  tagsExistentes: readonly string[] = [],
): Preparo {
  const prontas: LinhaPronta[] = [];
  const problemas: LinhaComProblema[] = [];
  const porVariante = new Map<string, LinhaPronta>();
  const celula = (l: readonly unknown[], i: number | null) =>
    i === null ? "" : String(l[i] ?? "").replace(/\s+/g, " ").trim();

  linhas.forEach((l, idx) => {
    const linha = idx + 2;
    const nome = celula(l, m.nome).slice(0, 200);
    const bruto = celula(l, m.telefone);
    // Linha inteiramente vazia (comum no fim de planilha) não é problema de ninguém.
    if (l.every((v) => String(v ?? "").trim() === "")) return;

    const tel = telefoneDaPlanilha(bruto);
    if ("motivo" in tel) {
      problemas.push({ linha, motivo: tel.motivo, telefoneBruto: bruto, nome });
      return;
    }

    const tags = m.tags === null ? [] : separarTags(l[m.tags]).map((t) => canonizarTag(t, tagsExistentes));
    const variantes = phoneLookupVariants(tel.e164);
    const repetida = variantes.map((v) => porVariante.get(v)).find(Boolean);
    if (repetida) {
      repetida.tags = [...new Set([...repetida.tags, ...tags])].slice(0, MAX_TAGS);
      problemas.push({ linha, motivo: "duplicado_no_arquivo", telefoneBruto: bruto, nome });
      return;
    }

    const email = celula(l, m.email).toLowerCase();
    const pronta: LinhaPronta = {
      linha,
      telefone: tel.e164,
      nome: nome || null,
      email: EMAIL_RX.test(email) ? email.slice(0, 254) : null,
      tags: [...new Set(tags)].slice(0, MAX_TAGS),
    };
    prontas.push(pronta);
    for (const v of variantes) porVariante.set(v, pronta);
  });

  return { prontas, problemas };
}

/** Lotes para a API, na ordem da planilha. */
export function emLotes<T>(itens: readonly T[], tamanho = LINHAS_POR_LOTE): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}
