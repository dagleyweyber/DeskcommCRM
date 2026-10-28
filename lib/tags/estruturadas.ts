/**
 * Tags ESTRUTURADAS — `grupo:valor` dentro do mesmo `tags text[]` de sempre.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * Tag solta ("vip", "quente", "meta") não diz de que tipo de coisa ela é: o filtro do
 * Kanban lista tudo misturado, ninguém sabe se "quente" é temperatura ou nome de
 * campanha, e o mesmo conceito nasce com três grafias. Um GRUPO dá o tipo
 * (Temperatura, Origem, Campanha, Anúncio) e, onde faz sentido, a regra
 * (a temperatura é uma só por lead).
 *
 * ─── Por que dentro de `tags` e não em tabela nova ──────────────────────────
 * Filtro do Kanban, público de campanha (`contains("tags", [tag])`), automações
 * (`add_tag`, `lead.tag_added`), MCP e webhooks já leem `tags`. Tabela nova faria
 * cada um deles aprender um segundo lugar, e o clone que atualiza receberia migration
 * sem ganhar nada. O formato `grupo:valor` convive: quem não conhece o grupo vê uma
 * tag comum, como sempre foi. Medido em produção (2026-10-28): nenhum lead tinha tag
 * com ":" — não há colisão.
 *
 * Este arquivo é PURO. Quem decide O QUE aplicar é `lib/atribuicao/tags-de-origem.ts`;
 * quem grava é `lib/atribuicao/aplicar-tags.ts`.
 */

export const SEPARADOR = ":";

/** Grupos conhecidos. Vocabulário FECHADO no código — acrescentar grupo é decisão de produto. */
export const GRUPO = {
  TEMPERATURA: "temperatura",
  ORIGEM: "origem",
  CAMPANHA: "campanha",
  ANUNCIO: "anuncio",
} as const;
export type GrupoChave = (typeof GRUPO)[keyof typeof GRUPO];

/** Cor semântica do valor — a tela traduz para token de tema, aqui não há CSS. */
export type Tom = "quente" | "morno" | "frio" | "neutro";

export interface ValorDeTag {
  valor: string;
  rotulo: string;
  tom: Tom;
}

export interface GrupoDeTag {
  chave: GrupoChave;
  rotulo: string;
  /** Um valor só por lead: pôr "frio" tira "quente". */
  exclusivo: boolean;
  /** Aplicado pelo sistema a partir da atribuição; a pessoa não edita à mão. */
  automatico: boolean;
  /** `null` = vocabulário aberto (nome de campanha/anúncio vem da plataforma de mídia). */
  valores: readonly ValorDeTag[] | null;
}

/** Valores de Origem. Meta Ads e Instagram NÃO são excludentes: anúncio do Instagram é anúncio da Meta. */
export const ORIGEM = {
  META_ADS: "meta-ads",
  INSTAGRAM: "instagram",
  GOOGLE_ADS: "google-ads",
  TIKTOK_ADS: "tiktok-ads",
} as const;

export const TEMPERATURA = {
  QUENTE: "quente",
  MORNO: "morno",
  FRIO: "frio",
} as const;

export const GRUPOS: readonly GrupoDeTag[] = [
  {
    chave: GRUPO.TEMPERATURA,
    rotulo: "Temperatura",
    exclusivo: true,
    automatico: false,
    valores: [
      { valor: TEMPERATURA.QUENTE, rotulo: "Quente", tom: "quente" },
      { valor: TEMPERATURA.MORNO, rotulo: "Morno", tom: "morno" },
      { valor: TEMPERATURA.FRIO, rotulo: "Frio", tom: "frio" },
    ],
  },
  {
    chave: GRUPO.ORIGEM,
    rotulo: "Origem",
    exclusivo: false,
    automatico: true,
    valores: [
      { valor: ORIGEM.META_ADS, rotulo: "Meta Ads", tom: "neutro" },
      { valor: ORIGEM.INSTAGRAM, rotulo: "Instagram", tom: "neutro" },
      { valor: ORIGEM.GOOGLE_ADS, rotulo: "Google Ads", tom: "neutro" },
      { valor: ORIGEM.TIKTOK_ADS, rotulo: "TikTok Ads", tom: "neutro" },
    ],
  },
  { chave: GRUPO.CAMPANHA, rotulo: "Campanha", exclusivo: true, automatico: true, valores: null },
  { chave: GRUPO.ANUNCIO, rotulo: "Anúncio", exclusivo: true, automatico: true, valores: null },
];

const POR_CHAVE: ReadonlyMap<string, GrupoDeTag> = new Map(GRUPOS.map((g) => [g.chave, g]));

export function grupoDe(chave: string): GrupoDeTag | null {
  return POR_CHAVE.get(chave) ?? null;
}

/** Tamanho máximo do valor — nome de anúncio pode ser enorme e a tag aparece em chip. */
export const LIMITE_DO_VALOR = 80;

/**
 * Valor pronto para ir na tag: sem espaço sobrando e SEM VÍRGULA — o formulário do
 * lead separa as tags por vírgula, e uma vírgula no nome da campanha a partiria em
 * duas. Vazio devolve "".
 */
export function limpaValor(texto: string | null | undefined): string {
  if (!texto) return "";
  return texto.replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITE_DO_VALOR).trim();
}

/** Valor aceito pelo grupo: grupo fechado só aceita o que está no vocabulário. */
function valorAceito(grupo: GrupoDeTag, valor: string): boolean {
  if (!valor) return false;
  return grupo.valores === null || grupo.valores.some((v) => v.valor === valor);
}

export function montaTag(chave: GrupoChave, valor: string | null | undefined): string | null {
  const grupo = grupoDe(chave);
  const limpo = limpaValor(valor);
  if (!grupo || !valorAceito(grupo, limpo)) return null;
  return `${chave}${SEPARADOR}${limpo}`;
}

/** `grupo:valor` de um grupo CONHECIDO, ou null (tag comum, ou grupo que não existe aqui). */
export function lerTag(tag: string): { grupo: GrupoChave; valor: string } | null {
  const i = tag.indexOf(SEPARADOR);
  if (i <= 0) return null;
  const chave = tag.slice(0, i);
  const valor = tag.slice(i + 1);
  if (!valor || !grupoDe(chave)) return null;
  return { grupo: chave as GrupoChave, valor };
}

export function valoresDoGrupo(tags: readonly string[], chave: GrupoChave): string[] {
  const achados: string[] = [];
  for (const t of tags) {
    const l = lerTag(t);
    if (l && l.grupo === chave) achados.push(l.valor);
  }
  return achados;
}

/**
 * Põe o valor no grupo. Grupo exclusivo troca o que havia; grupo aberto-múltiplo
 * acrescenta. Idempotente, preserva a ordem e toda tag de outro tipo. Valor que o
 * grupo não aceita devolve as tags como estavam.
 */
export function comValor(tags: readonly string[], chave: GrupoChave, valor: string): string[] {
  const grupo = grupoDe(chave);
  const nova = montaTag(chave, valor);
  if (!grupo || !nova) return [...tags];
  if (tags.includes(nova) && (!grupo.exclusivo || valoresDoGrupo(tags, chave).length === 1)) return [...tags];
  const base = grupo.exclusivo ? semGrupo(tags, chave) : tags.filter((t) => t !== nova);
  return [...base, nova];
}

/** Tira todos os valores do grupo (ex.: "sem temperatura"). */
export function semGrupo(tags: readonly string[], chave: GrupoChave): string[] {
  return tags.filter((t) => lerTag(t)?.grupo !== chave);
}

export interface TagsSeparadas {
  porGrupo: Record<GrupoChave, string[]>;
  /** Tudo o que não é de grupo conhecido — inclusive "plano:gold" de um grupo que não existe aqui. */
  livres: string[];
}

export function separaTags(tags: readonly string[]): TagsSeparadas {
  const porGrupo = Object.fromEntries(GRUPOS.map((g) => [g.chave, [] as string[]])) as Record<GrupoChave, string[]>;
  const livres: string[] = [];
  for (const t of tags) {
    const l = lerTag(t);
    if (l) porGrupo[l.grupo].push(l.valor);
    else livres.push(t);
  }
  return { porGrupo, livres };
}

/**
 * Tags do lead depois que a pessoa editou o campo de tags LIVRES do formulário.
 *
 * As de grupo conhecido que o lead já tinha ficam: têm campo próprio (temperatura) ou
 * são automáticas (origem, campanha, anúncio) e o campo de texto não as mostra — sem
 * isto, salvar o formulário apagaria a origem do lead. As livres digitadas substituem
 * as livres antigas. Se a pessoa DIGITAR `temperatura:frio` no campo livre, vale como
 * marcar a temperatura (troca a anterior); valor que o grupo não aceita fica como tag
 * comum, em vez de sumir sem aviso.
 */
export function mesclaTagsLivres(atuais: readonly string[], digitadas: readonly string[]): string[] {
  let resultado = atuais.filter((t) => lerTag(t) !== null);
  for (const t of digitadas) {
    const l = lerTag(t);
    if (l && montaTag(l.grupo, l.valor)) resultado = comValor(resultado, l.grupo, l.valor);
    else if (!resultado.includes(t)) resultado.push(t);
  }
  return resultado;
}

export interface SecaoDeFiltro {
  /** `null` = "Outras tags" (as que não são de grupo conhecido). */
  grupo: GrupoChave | null;
  rotulo: string;
  itens: Array<{ tag: string; rotulo: string }>;
}

/**
 * As tags que existem num conjunto de leads, arrumadas por grupo para o filtro do
 * Kanban: Temperatura, Origem, Campanha, Anúncio e, por último, as livres. Seção sem
 * nenhuma tag não aparece. Só entram as tags que ALGUM lead do quadro tem — filtro
 * que oferece opção que devolve zero cards parece quebrado.
 */
export function secoesDeFiltro(tagsExistentes: Iterable<string>): SecaoDeFiltro[] {
  const unicas = [...new Set(tagsExistentes)];
  const porRotulo = (a: { rotulo: string }, b: { rotulo: string }) => a.rotulo.localeCompare(b.rotulo, "pt-BR");
  const secoes: SecaoDeFiltro[] = [];
  for (const g of GRUPOS) {
    const itens = unicas
      .map((tag) => ({ tag, l: lerTag(tag) }))
      .filter((x) => x.l?.grupo === g.chave)
      .map((x) => ({ tag: x.tag, rotulo: rotuloDoValor(g.chave, x.l!.valor) }))
      .sort(porRotulo);
    if (itens.length > 0) secoes.push({ grupo: g.chave, rotulo: g.rotulo, itens });
  }
  const livres = unicas
    .filter((t) => lerTag(t) === null)
    .map((tag) => ({ tag, rotulo: tag }))
    .sort(porRotulo);
  if (livres.length > 0) secoes.push({ grupo: null, rotulo: "Outras tags", itens: livres });
  return secoes;
}

/** Texto do botão do filtro: "Temperatura: Quente" para tag de grupo, a própria tag nas livres. */
export function rotuloDaTag(tag: string): string {
  const l = lerTag(tag);
  if (!l) return tag;
  return `${grupoDe(l.grupo)?.rotulo ?? l.grupo}: ${rotuloDoValor(l.grupo, l.valor)}`;
}

/** Como o valor aparece na tela: o rótulo do vocabulário, ou o próprio texto (campanha, anúncio). */
export function rotuloDoValor(chave: GrupoChave, valor: string): string {
  return grupoDe(chave)?.valores?.find((v) => v.valor === valor)?.rotulo ?? valor;
}

export function tomDoValor(chave: GrupoChave, valor: string): Tom {
  return grupoDe(chave)?.valores?.find((v) => v.valor === valor)?.tom ?? "neutro";
}
