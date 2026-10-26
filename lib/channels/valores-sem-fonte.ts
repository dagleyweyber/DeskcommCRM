/**
 * As variáveis de um modelo que o mapeamento da campanha/automação NÃO preenche.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 * Achado ao vivo (B'Laser Parnamirim): campanha de teste com um modelo de 3 variáveis,
 * criada com o mapeamento VAZIO. A tela mostrava um campo por variável, mas deixava criar
 * sem preencher nenhum, e a API aceitava `variable_mapping: {}`. O erro só aparecia no
 * disparo — e como a frase gravada na campanha era genérica ("canal indisponível no
 * momento do envio"), o motivo real (`template_missing_values: espera 3 valor(es) —
 * falta: 1, 2, 3`) só existia na linha da mensagem.
 *
 * A API já recusava campanha com canal fora do ar e modelo não aprovado, pelo mesmo
 * princípio: "todo destinatário nasceria condenado a falhar". Mapeamento incompleto é a
 * mesma classe, e se confere no mesmo lugar — antes de gravar, com uma frase que diz o
 * que fazer.
 *
 * Usa o MESMO contrato de slots do formulário e do envio (`deriveTemplateContract` +
 * `slotKey`): uma contagem de variáveis feita por outro caminho divergiria dele.
 */
import { slotKey } from "./meta/build-components";
import { deriveTemplateContract, type TemplateContract } from "./meta/template-contract";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

export interface ValorSemFonte {
  /** A chave do slot no mapeamento (`slotKey`). */
  chave: string;
  /** Como a tela chama a variável: `{{1}}`, `{{nome}}`. */
  rotulo: string;
}

/** A definição crua do modelo, como o espelho local a guarda. */
export type Definicao = Parameters<typeof deriveTemplateContract>[0];

/**
 * Slot sem origem: ausente do mapeamento, ou "texto fixo" com valor em branco (campo
 * aberto na tela e nunca preenchido). Origens que calculam o valor (nome do contato,
 * data do agendamento) preenchem por si.
 */
export function valoresSemFonte(
  definicao: Definicao | TemplateContract,
  mapping: VariableMapping,
): ValorSemFonte[] {
  const contrato =
    "slots" in definicao && "parameterFormat" in definicao
      ? (definicao as TemplateContract)
      : deriveTemplateContract(definicao as Definicao);

  const faltando: ValorSemFonte[] = [];
  for (const slot of contrato.slots) {
    const chave = slotKey(slot.address, slot.key);
    const fonte = mapping[chave];
    const vazia = !fonte || (fonte.kind === "fixed" && !fonte.value.trim());
    if (vazia) faltando.push({ chave, rotulo: `{{${slot.key}}}` });
  }
  return faltando;
}

/** A frase que a API devolve e a tela mostra. */
export function fraseDosValoresSemFonte(faltando: ValorSemFonte[]): string {
  const lista = faltando.map((f) => f.rotulo).join(", ");
  return (
    `Falta escolher o valor de ${lista}. ` +
    "Para cada variável do modelo, escolha um texto fixo ou um dado do contato — " +
    "sem isso o envio é recusado."
  );
}
