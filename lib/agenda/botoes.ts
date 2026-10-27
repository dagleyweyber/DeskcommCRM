/**
 * Funções PURAS da confirmação automática (migration 0201): ler os botões de um
 * modelo e decidir o que o clique do cliente significa. Moram aqui, e não em
 * `confirmacao.ts`, porque a tela de nova automação (código de NAVEGADOR) as
 * usa — e `confirmacao.ts` importa auditoria e logger, que puxam
 * `next/headers` (só existe no servidor). Importar daquele arquivo num
 * componente de cliente quebra o `next build` da imagem.
 */

export type DecisaoDoCliente = "confirmed" | "declined";

/** Compara texto de botão sem se importar com caixa, acento ou espaço sobrando. */
export function normalizaTextoDeBotao(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Os botões de resposta rápida (QUICK_REPLY) de um modelo, na ordem — é o que
 * a tela oferece para "qual botão confirma" e o que a API confere ao salvar.
 */
export function botoesDeRespostaRapida(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const textos: string[] = [];
  for (const c of components as Array<Record<string, unknown>>) {
    if (String(c?.type ?? "").toUpperCase() !== "BUTTONS" || !Array.isArray(c.buttons)) continue;
    for (const b of c.buttons as Array<Record<string, unknown>>) {
      if (String(b?.type ?? "").toUpperCase() === "QUICK_REPLY" && typeof b.text === "string" && b.text.trim()) {
        textos.push(b.text);
      }
    }
  }
  return textos;
}

/**
 * O que o cliente quis dizer com o botão. Compara o texto visível e o
 * `payload` (a Meta devolve o texto do botão como payload quando o envio não
 * define um). Nada configurado ou botão diferente → `null` (não mexe em nada).
 */
export function classificaResposta(
  resposta: { texto: string | null; payload: string | null },
  automacao: { confirm_button_text: string | null; decline_button_text: string | null },
): DecisaoDoCliente | null {
  const candidatos = [resposta.texto, resposta.payload].map(normalizaTextoDeBotao).filter(Boolean);
  const confirma = normalizaTextoDeBotao(automacao.confirm_button_text);
  const desmarca = normalizaTextoDeBotao(automacao.decline_button_text);
  if (confirma && candidatos.includes(confirma)) return "confirmed";
  if (desmarca && candidatos.includes(desmarca)) return "declined";
  return null;
}
