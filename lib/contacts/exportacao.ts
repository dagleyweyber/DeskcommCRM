/**
 * Exportação de contatos de uma conexão de WhatsApp para CSV — a parte PURA
 * (sem banco, sem rede): colunas, escape e montagem do arquivo.
 *
 * Quem busca os dados é `contatos-do-canal.ts`; quem autoriza e audita é a rota.
 * Separar assim deixa o formato do arquivo testável sem mockar Supabase.
 *
 * Duas decisões que não são óbvias:
 *  - **Proteção contra fórmula.** Célula que começa com `=`, `+`, `-` ou `@`
 *    vira fórmula no Excel/Sheets. Nome de contato vem do WhatsApp, ou seja, de
 *    quem escreveu — `=HYPERLINK(...)` como nome seria execução no computador de
 *    quem abre o arquivo. Prefixamos com apóstrofo (padrão OWASP).
 *  - **BOM UTF-8.** Sem ele o Excel em pt-BR abre "João" como "JoÃ£o".
 */

export interface ContatoExportavel {
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  email: string | null;
  tags: string[] | null;
  source: string | null;
  is_blocked: boolean | null;
  consent: unknown;
  created_at: string | null;
}

export interface LinhaDoCanal {
  contato: ContatoExportavel;
  /** Primeira e última atividade da conversa NESTE canal (não do contato inteiro). */
  primeira_conversa_em: string | null;
  ultima_mensagem_em: string | null;
}

export const CABECALHO_EXPORTACAO = [
  "nome",
  "telefone",
  "email",
  "tags",
  "origem",
  "primeira_conversa_em",
  "ultima_mensagem_em",
  "bloqueado",
  "consentimento_marketing",
] as const;

const BOM = "﻿";

/** Escapa uma célula: aspas, vírgula e quebra de linha, mais o guard de fórmula. */
export function celulaCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Telefone puro (`+5581...`) começa com `+` mas não é fórmula: prefixar
  // estragaria TODO telefone do arquivo. `+1+1` e afins continuam protegidos.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Consentimento de marketing lido de `contacts.consent` (jsonb):
 * `revogado` ganha de `concedido` — quem revogou depois não volta a "sim" por
 * ter concedido antes. Sem registro nenhum é "nao_informado", não "nao".
 */
export function consentimentoDeMarketing(consent: unknown): "concedido" | "revogado" | "nao_informado" {
  const m = (consent as { marketing?: { granted_at?: string; revoked_at?: string } } | null)?.marketing;
  if (m?.revoked_at) return "revogado";
  if (m?.granted_at) return "concedido";
  return "nao_informado";
}

export function linhaDoContato(l: LinhaDoCanal): string[] {
  const c = l.contato;
  return [
    c.name ?? c.display_name ?? "",
    c.phone_number ?? "",
    c.email ?? "",
    (c.tags ?? []).join("|"),
    c.source ?? "",
    l.primeira_conversa_em ?? "",
    l.ultima_mensagem_em ?? "",
    c.is_blocked ? "sim" : "nao",
    consentimentoDeMarketing(c.consent),
  ];
}

export function montarCsv(linhas: LinhaDoCanal[]): string {
  const corpo = [CABECALHO_EXPORTACAO.join(","), ...linhas.map((l) => linhaDoContato(l).map(celulaCsv).join(","))];
  return BOM + corpo.join("\r\n") + "\r\n";
}

/** Nome de arquivo seguro para o `Content-Disposition`: só [a-z0-9-], sem acento. */
export function nomeDoArquivo(rotulo: string, hoje: Date): string {
  const slug =
    rotulo
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "canal";
  return `contatos-${slug}-${hoje.toISOString().slice(0, 10)}.csv`;
}
