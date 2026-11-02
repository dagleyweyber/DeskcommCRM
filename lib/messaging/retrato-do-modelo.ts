/**
 * O que o cliente VIU além do corpo de uma mensagem de modelo: cabeçalho de
 * texto, rodapé e botões.
 *
 * Achado ao vivo (B'Laser Parnamirim, 2026-11-02): campanha e confirmação de
 * agendamento saíam com "Confirmar" / "Preciso reagendar", e o inbox mostrava só
 * o corpo — a equipe via a RESPOSTA "Confirmar" chegar sem saber que opções o
 * cliente tinha. `messages.body` guarda só o corpo; os botões viviam apenas na
 * definição (`meta_templates.components`).
 *
 * ─── Por que um RETRATO gravado na mensagem e não uma consulta na hora ──────
 * A definição muda (o operador edita e reaprova) e some (é excluída na
 * plataforma). A mensagem é histórico: precisa mostrar o que foi enviado
 * naquele dia, não o que o modelo diz hoje. Por isso o envio grava em
 * `messages.metadata.template` a versão que o pré-voo acabou de aprovar
 * (`conferirDefinicao`), com as variáveis já trocadas pelos valores enviados.
 *
 * Neutro de propósito (`lib/messaging/`): campanha, automação, IA e envio manual
 * passam todos por `sendMessageHandler`, que é quem grava.
 */

export interface BotaoDoModelo {
  /** Como a plataforma nomeia: `QUICK_REPLY`, `URL`, `PHONE_NUMBER`, `COPY_CODE`… */
  type: string;
  text: string;
  /** Só em `URL`, com a parte variável já preenchida quando o valor foi enviado. */
  url?: string;
  /** Só em `PHONE_NUMBER`. */
  phone?: string;
}

export interface RetratoDoModelo {
  /** Só cabeçalho de TEXTO — mídia de cabeçalho já tem caminho próprio (`media_storage_path`). */
  header: string | null;
  footer: string | null;
  buttons: BotaoDoModelo[];
}

type Bruto = Record<string, unknown>;

const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

/** Troca `{{n}}` pelo valor do slot com aquele prefixo (`header:`, `button0:`); sem valor, fica como está. */
function preencher(texto: string, valores: Record<string, string>, prefixo: string): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (m, k: string) => valores[`${prefixo}${k}`] ?? m);
}

/**
 * Retrato a gravar na mensagem. `null` quando não há nada além do corpo — aí a
 * mensagem não ganha chave nenhuma, e a bolha segue como sempre foi.
 *
 * Tolerante a caixa e a campo ausente, como `lerConteudo`: a leitura vem da
 * plataforma em maiúsculas, a escrita do intermediário em minúsculas.
 */
export function retratoDoModelo(
  components: unknown,
  valores: Record<string, string> = {},
): RetratoDoModelo | null {
  const lista = Array.isArray(components) ? components : [];
  const retrato: RetratoDoModelo = { header: null, footer: null, buttons: [] };

  for (const bruto of lista) {
    const c = obj(bruto);
    if (!c) continue;
    const tipo = (str(c.type) ?? "").toUpperCase();

    if (tipo === "HEADER") {
      const formato = (str(c.format) ?? "TEXT").toUpperCase();
      const texto = str(c.text);
      if (formato === "TEXT" && texto) retrato.header = preencher(texto, valores, "header:");
    } else if (tipo === "FOOTER") {
      retrato.footer = str(c.text);
    } else if (tipo === "BUTTONS") {
      const botoes = Array.isArray(c.buttons) ? c.buttons : [];
      botoes.forEach((b, i) => {
        const o = obj(b);
        const texto = o ? str(o.text) : null;
        if (!o || !texto) return;
        const botao: BotaoDoModelo = { type: (str(o.type) ?? "").toUpperCase(), text: texto };
        const url = str(o.url);
        if (url) botao.url = preencher(url, valores, `button${i}:`);
        const telefone = str(o.phone_number);
        if (telefone) botao.phone = telefone;
        retrato.buttons.push(botao);
      });
    }
  }

  return retrato.header || retrato.footer || retrato.buttons.length > 0 ? retrato : null;
}

/**
 * Lê o retrato de volta de `messages.metadata` para a tela. Defensivo: o jsonb
 * aceita qualquer coisa, e uma linha malformada não pode derrubar a conversa —
 * no pior caso a bolha mostra só o corpo, como antes.
 */
export function lerRetratoDoModelo(metadata: unknown): RetratoDoModelo | null {
  const t = obj(obj(metadata)?.template);
  if (!t) return null;
  const buttons: BotaoDoModelo[] = [];
  for (const b of Array.isArray(t.buttons) ? t.buttons : []) {
    const o = obj(b);
    const text = o ? str(o.text) : null;
    if (!o || !text) continue;
    buttons.push({
      type: str(o.type) ?? "",
      text,
      ...(str(o.url) ? { url: str(o.url) as string } : {}),
      ...(str(o.phone) ? { phone: str(o.phone) as string } : {}),
    });
  }
  const header = str(t.header);
  const footer = str(t.footer);
  return header || footer || buttons.length > 0 ? { header, footer, buttons } : null;
}
