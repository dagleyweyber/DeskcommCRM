/**
 * O CONTEÚDO de uma definição aprovada, legível.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * A lista mostrava só nome, idioma e estado. Ver "APPROVED" sem ver o texto
 * obriga o operador a abrir a plataforma para saber o que a definição diz — e é
 * o texto que ele precisa para escolher qual mandar.
 *
 * ─── E por que os EXEMPLOS têm caso próprio ────────────────────────────────
 *
 * Medido no contrato da plataforma: o corpo aceita `{{n}}`, e o `example` com
 * valores de amostra é o que a revisão exige. Uma definição com variável e SEM
 * exemplo é recusada — e a recusa chega horas depois, sem que ninguém ligue uma
 * coisa à outra.
 *
 * Foi exatamente o que o formulário fazia: deixava digitar `{{1}}` e não
 * coletava o exemplo. Rejeição garantida, por omissão da nossa tela.
 */

/**
 * Os códigos de idioma que a plataforma aceita (`message_template_language`).
 *
 * LISTA, e não campo livre. O contrato descreve o formato mas não enumera os
 * valores, e digitar é onde o erro nasce: `esp`, `ES`, `es-AR` e `español` são
 * todos recusados, e a recusa vem como "language not supported" horas depois.
 * Escolher de uma lista não erra.
 *
 * Não é a lista INTEIRA da Meta (são dezenas): são os idiomas com que este
 * público trabalha, mais os que aparecem em conta de teste. Faltar um é um
 * pedido de uma linha; oferecer sessenta faz o operador procurar o dele numa
 * lista que não termina.
 */
export const IDIOMAS_DA_DEFINICAO: { codigo: string; rotulo: string }[] = [
  { codigo: "es", rotulo: "Espanhol" },
  { codigo: "es_AR", rotulo: "Espanhol (Argentina)" },
  { codigo: "es_MX", rotulo: "Espanhol (México)" },
  { codigo: "es_ES", rotulo: "Espanhol (Espanha)" },
  { codigo: "pt_BR", rotulo: "Português (Brasil)" },
  { codigo: "pt_PT", rotulo: "Português (Portugal)" },
  { codigo: "en", rotulo: "Inglês" },
  { codigo: "en_US", rotulo: "Inglês (EUA)" },
  { codigo: "en_GB", rotulo: "Inglês (Reino Unido)" },
];

/** Limites da plataforma. Passar deles é recusa, e o contador evita descobrir tarde. */
export const LIMITE_CORPO = 1024;
export const LIMITE_RODAPE = 60;
export const LIMITE_BOTOES = 3;

export type TipoDeBotao = "quick_reply" | "url" | "phone_number";

export interface BotaoDaDefinicao {
  tipo: TipoDeBotao;
  texto: string;
  /** Só para `url`. */
  url?: string;
  /**
   * Só para `url`: o destino é escolhido em cada campanha. O modelo vai para a
   * revisão com `<crm>/l/{{1}}` (ver migration 0216) e `url` é ignorada.
   */
  linkNaCampanha?: boolean;
  /** Só para `phone_number`. */
  telefone?: string;
}

/** Caminho público que redireciona o botão de link da campanha (`app/l/[codigo]`). */
export const CAMINHO_DO_LINK_DA_CAMPANHA = "/l/";

/** O endereço que vai na aprovação: `https://crm…/l/{{1}}`. */
export function urlDoLinkDaCampanha(origem: string): string {
  return `${origem.replace(/\/+$/, "")}${CAMINHO_DO_LINK_DA_CAMPANHA}{{1}}`;
}

/** O botão é de link escolhido na campanha? Lê a URL como a Meta a devolve. */
export function ehLinkDaCampanha(url: string | null | undefined): boolean {
  return /\/l\/\{\{1\}\}$/.test(url ?? "");
}

/**
 * Chaves de formulário (`slotKey`) dos botões de link da campanha de um modelo
 * aprovado. Mesma chave que `slotKey({kind:"button",index}, "1")` monta: corpo
 * sem prefixo, botão `button<i>:`.
 */
export function slotsDeLinkDaCampanha(components: unknown): string[] {
  const lista = Array.isArray(components) ? (components as Bruto[]) : [];
  const botoes = lista.find((c) => String(c.type ?? "").toUpperCase() === "BUTTONS")?.buttons;
  if (!Array.isArray(botoes)) return [];
  const out: string[] = [];
  botoes.forEach((b, i) => {
    const bt = obj(b);
    if (bt && String(bt.type ?? "").toUpperCase() === "URL" && ehLinkDaCampanha(str(bt.url))) {
      out.push(`button${i}:1`);
    }
  });
  return out;
}

/** Domínios que a Meta recusa no botão ("Direct links to WhatsApp aren't allowed"). */
const LINK_DO_WHATSAPP = /^(https?:\/\/)?([a-z0-9-]+\.)*(wa\.me|whatsapp\.com|whatsapp\.net)(\/|$)/i;

/**
 * O que impede os botões de irem para a revisão, dito antes de enviar.
 *
 * Antes, botão de link sem endereço era tirado EM SILÊNCIO: o
 * `2_campanha_11_11` da B'Laser foi aprovado sem o botão que o texto mandava
 * tocar, porque o endereço ia ser "colocado na campanha" (2026-11-08).
 */
export function problemasDosBotoes(botoes: BotaoDaDefinicao[]): string[] {
  const out: string[] = [];
  botoes.forEach((b, i) => {
    const nome = `Botão ${i + 1}${b.texto.trim() ? ` ("${b.texto.trim()}")` : ""}`;
    if (!textoDeBotaoAceitoPelaMeta(b.texto)) out.push(`${nome}: falta o texto do botão.`);
    if (b.tipo === "url" && !b.linkNaCampanha) {
      const url = (b.url ?? "").trim();
      if (!url) {
        out.push(`${nome}: falta o endereço. Para escolher o link em cada campanha, use "Link escolhido na campanha".`);
      } else if (LINK_DO_WHATSAPP.test(url)) {
        out.push(`${nome}: a Meta não aceita link do WhatsApp no botão. Use "Link escolhido na campanha" — o CRM redireciona.`);
      } else if (!/^https?:\/\//i.test(url)) {
        out.push(`${nome}: o endereço precisa começar com https://`);
      }
    }
    if (b.tipo === "phone_number" && !(b.telefone ?? "").trim()) out.push(`${nome}: falta o telefone.`);
  });
  return out;
}

type Bruto = Record<string, unknown>;

const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export interface ConteudoDaDefinicao {
  header: { formato: string; texto: string | null } | null;
  body: string | null;
  footer: string | null;
  botoes: { tipo: string; texto: string }[];
  /** Quantos `{{n}}` o corpo declara — o que o envio vai precisar preencher. */
  variaveis: number;
}

/**
 * Lê o payload cru como a plataforma o devolveu.
 *
 * Tolerante a caixa (`BODY` e `body` convivem: a leitura vem da Meta em
 * maiúsculas, a escrita do intermediário em minúsculas) e a campo ausente —
 * uma definição sem rodapé é normal, não erro.
 */
export function lerConteudo(components: unknown): ConteudoDaDefinicao {
  const lista = Array.isArray(components) ? components : [];
  const vazio: ConteudoDaDefinicao = {
    header: null,
    body: null,
    footer: null,
    botoes: [],
    variaveis: 0,
  };

  for (const bruto of lista) {
    const c = obj(bruto);
    if (!c) continue;
    const tipo = (str(c.type) ?? "").toUpperCase();

    if (tipo === "HEADER") {
      vazio.header = {
        formato: (str(c.format) ?? "TEXT").toUpperCase(),
        texto: str(c.text),
      };
    } else if (tipo === "BODY") {
      vazio.body = str(c.text);
    } else if (tipo === "FOOTER") {
      vazio.footer = str(c.text);
    } else if (tipo === "BUTTONS") {
      const bts = Array.isArray(c.buttons) ? c.buttons : [];
      for (const b of bts) {
        const o = obj(b);
        if (!o) continue;
        vazio.botoes.push({
          tipo: (str(o.type) ?? "").toUpperCase(),
          texto: str(o.text) ?? "",
        });
      }
    }
  }

  vazio.variaveis = contarVariaveis(vazio.body ?? "");
  return vazio;
}

/**
 * Quantos `{{n}}` distintos o texto usa.
 *
 * DISTINTOS, e pelo MAIOR índice: um texto que repete `{{1}}` duas vezes pede
 * um valor, não dois — e um que usa `{{1}}` e `{{3}}` pede três, porque a
 * plataforma numera por posição e recusa a lista com buracos.
 */
export function contarVariaveis(texto: string): number {
  const achados = [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return achados.length === 0 ? 0 : Math.max(...achados);
}

/**
 * Transforma o que a pessoa digita no NOME que a plataforma aceita: só letras
 * minúsculas, números e sublinhado.
 *
 * ─── Por que normaliza na tela, e não confia na recusa ────────────────────
 * O nome é o primeiro campo do formulário e o último a ser conferido: a plataforma
 * o recusa só depois que o corpo, os exemplos e os botões já foram preenchidos, com
 * uma frase em inglês traduzida ("o nome só pode ter letras minúsculas e
 * sublinhados"). Quem digita "Confirmação de Agendamento" perdia a paciência antes de
 * entender o que errou.
 *
 * A PLATAFORMA continua sendo a autoridade — se ela mudar a regra, a recusa vem como
 * sempre. Isto só converte o que é conversível sem mudar o sentido: caixa alta vira
 * baixa, acento sai, espaço e hífen viram sublinhado, o resto é descartado.
 */
export function normalizarNomeDoModelo(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // acentos: ç→c, ã→a, é→e
    .toLowerCase()
    .replace(/[\s-]+/g, "_") // espaço e hífen viram sublinhado
    .replace(/[^a-z0-9_]/g, "") // o que sobrar de inválido sai
    .replace(/_{2,}/g, "_") // sublinhado repetido (por " - ") vira um só
    // Sem sublinhado no COMEÇO. O do FIM fica de propósito: é o que a pessoa acabou de
    // digitar ao apertar a barra de espaço entre duas palavras — tirá-lo a cada tecla
    // impediria de escrever um nome com mais de uma. Quem envia usa `semSublinhadoNoFim`.
    .replace(/^_+/, "");
}

/** O nome na hora de ENVIAR: sem o sublinhado que sobrou de um espaço no fim. */
export function semSublinhadoNoFim(nome: string): string {
  return nome.replace(/_+$/, "");
}

/** Limite de caracteres do nome (documentado pela plataforma). */
export const LIMITE_NOME_DO_MODELO = 512;

/**
 * A Meta recusa o modelo inteiro ("Buttons can't have any variables, newlines,
 * emojis, or formatting characters") se o texto do botão tiver emoji, quebra de
 * linha, `{{variável}}` ou formatação (`*`, `_`, `~`, crase). Um emoji colado do
 * celular basta. Limpa aqui em vez de devolver o erro só depois do envio.
 */
export function textoDeBotaoAceitoPelaMeta(texto: string): string {
  return texto
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, "")
    .replace(/[*_~`\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Monta os `components` de uma definição nova, com os exemplos que a revisão
 * exige.
 *
 * `example.body_text` é ARRAY DE ARRAYS — o formato do contrato, um conjunto de
 * amostras por variável. Mandar um array simples é recusado, e a mensagem de
 * erro não diz qual dos dois formatos ela queria.
 */
export function montarComponents(input: {
  body: string;
  footer?: string | null;
  exemplos: string[];
  cabecalho?: { texto?: string | null; midiaUrl?: string | null } | null;
  botoes?: BotaoDaDefinicao[];
  /** Endereço do CRM (`window.location.origin`) — obrigatório para botão de link da campanha. */
  origemDoLink?: string;
}): unknown[] {
  const n = contarVariaveis(input.body);
  const components: unknown[] = [];

  // O cabeçalho vem PRIMEIRO: a plataforma lê a ordem dos componentes como a
  // ordem da mensagem, e um header depois do corpo é recusado.
  const midia = input.cabecalho?.midiaUrl?.trim();
  const tituloTexto = input.cabecalho?.texto?.trim();
  if (midia) {
    // `header_handle` é o campo do contrato pra mídia de cabeçalho — mas
    // pede um HANDLE opaco da Resumable Upload API da Meta
    // (`lib/channels/meta/resumable-upload.ts`), não uma URL. Mandar URL
    // aqui é recusado com "Parâmetro de exemplo não fornecido para o tipo
    // do título" — achado ao vivo (RevitaFio Mossoró): este comentário
    // dizia o contrário até a 0172, e foi exatamente por isso que todo
    // template com imagem falhava, sempre, para qualquer imagem. Quem monta
    // este valor (`midia`, o parâmetro `cabecalho.midiaUrl`) tem que
    // entregar o handle já resolvido — o canal oficial resolve via
    // `app/api/v1/channels/templates/media`.
    components.push({
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: [midia] },
    });
  } else if (tituloTexto) {
    const cab: Bruto = { type: "HEADER", format: "TEXT", text: tituloTexto };
    const nCab = contarVariaveis(tituloTexto);
    // O cabeçalho tem exemplo PRÓPRIO (`header_text`), separado do corpo. Usar
    // o do corpo aqui manda a amostra errada e a revisão recusa.
    if (nCab > 0) cab.example = { header_text: Array.from({ length: nCab }, () => "exemplo") };
    components.push(cab);
  }

  const corpo: Bruto = { type: "BODY", text: input.body };
  if (n > 0) {
    // Preenche o que faltar com um marcador: o exemplo VAZIO é recusado pela
    // revisão, e um campo em branco esquecido no formulário não pode virar uma
    // recusa que só aparece horas depois.
    const amostras = Array.from({ length: n }, (_, i) => input.exemplos[i]?.trim() || "exemplo");
    corpo.example = { body_text: [amostras] };
  }
  components.push(corpo);

  const rodape = input.footer?.trim();
  if (rodape) components.push({ type: "FOOTER", text: rodape });

  // Botões por último, e todos num ÚNICO componente: o contrato pede
  // `{type:"BUTTONS", buttons:[…]}`, não um componente por botão.
  const botoes = (input.botoes ?? [])
    .map((b) => ({ ...b, texto: textoDeBotaoAceitoPelaMeta(b.texto) }))
    .filter((b) => b.texto)
    .slice(0, LIMITE_BOTOES)
    .map((b) => {
      const base: Bruto = { type: b.tipo.toUpperCase(), text: b.texto };
      if (b.tipo === "url" && b.linkNaCampanha && input.origemDoLink) {
        // URL com variável exige um exemplo completo na revisão, como o corpo.
        base.url = urlDoLinkDaCampanha(input.origemDoLink);
        base.example = [String(base.url).replace("{{1}}", "exemplo")];
      } else if (b.tipo === "url") base.url = (b.url ?? "").trim();
      if (b.tipo === "phone_number") base.phone_number = (b.telefone ?? "").trim();
      return base;
    })
    // URL sem endereço e telefone sem número são recusados pela revisão. Barrar
    // aqui evita mandar para revisão algo que já se sabe que volta.
    .filter((b) => (b.type !== "URL" || b.url) && (b.type !== "PHONE_NUMBER" || b.phone_number));

  if (botoes.length > 0) components.push({ type: "BUTTONS", buttons: botoes });

  return components;
}
