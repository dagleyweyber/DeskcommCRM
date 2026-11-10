/**
 * Por que uma campanha parou — o vocabulário de `whatsapp_campaigns.pausa_motivo` (migration 0218)
 * e o texto que a tela e a Central mostram para cada um.
 *
 * Módulo puro (sem banco): a tela de campanhas importa daqui o título e a ação de cada motivo,
 * e o servidor importa daqui o vocabulário que o CHECK do banco espelha.
 *
 * ⚠️ A FORMA de `MOTIVOS_DE_PAUSA` é requisito de instrumento: o par `whatsapp_campaigns.pausa_motivo`
 * de `tests/invariants/vocabulario-banco-x-typescript.test.ts` lê `const X = [...] as const`.
 */
export const MOTIVOS_DE_PAUSA = [
  "manual",
  "cobranca_recusada",
  "modelo_nota_amarela",
  "modelo_nota_vermelha",
  "modelo_pausado",
  "modelo_desativado",
  "alerta_da_conta",
  "violacao_da_conta",
  "numero_qualidade_baixa",
  "saidas_acima_do_limite",
] as const;
export type MotivoDePausa = (typeof MOTIVOS_DE_PAUSA)[number];

/**
 * O que o operador pode aceitar ao retomar: a nota do modelo ou do número é um RISCO, não um
 * bloqueio — a Meta ainda entrega. Retomar grava o motivo em `freios_dispensados` e o freio não
 * para de novo pela mesma nota. O resto não precisa de dispensa: modelo pausado/desativado é
 * bloqueio da Meta (retomar é recusado até ele voltar), e cobrança/saídas medem só o que saiu
 * depois da retomada.
 */
export const MOTIVOS_DISPENSAVEIS: readonly MotivoDePausa[] = [
  "modelo_nota_amarela",
  "modelo_nota_vermelha",
  "numero_qualidade_baixa",
];

export interface TextoDoMotivo {
  /** Curto, para o selo da campanha e o título do aviso. */
  titulo: string;
  /** O que fazer antes de retomar. */
  acao: string;
}

export const TEXTO_DO_MOTIVO: Record<MotivoDePausa, TextoDoMotivo> = {
  manual: {
    titulo: "Pausada pela equipe",
    acao: "Retome quando quiser continuar.",
  },
  cobranca_recusada: {
    titulo: "A Meta recusou a cobrança",
    acao: "Confira o cartão e a moeda da conta do WhatsApp Business no Gerenciador da Meta e retome.",
  },
  modelo_nota_amarela: {
    titulo: "Modelo com nota amarela",
    acao:
      "Muita gente está bloqueando ou ignorando esta mensagem. Revise o texto ou o público; retomar mantém o risco de a Meta pausar o modelo.",
  },
  modelo_nota_vermelha: {
    titulo: "Modelo com nota vermelha",
    acao:
      "A Meta está perto de pausar o modelo e a qualidade do número cai junto. O recomendado é trocar o modelo ou o público antes de continuar.",
  },
  modelo_pausado: {
    titulo: "A Meta pausou o modelo",
    acao:
      "A Meta não entrega este modelo enquanto ele estiver pausado. Aguarde ele voltar a ficar aprovado (ou use outro modelo) para retomar.",
  },
  modelo_desativado: {
    titulo: "Modelo desativado ou reprovado",
    acao: "Este modelo não pode mais ser usado. Crie a campanha de novo com outro modelo aprovado.",
  },
  alerta_da_conta: {
    titulo: "Alerta da Meta na conta",
    acao: "Abra o Gerenciador do WhatsApp, leia o alerta e resolva antes de retomar.",
  },
  violacao_da_conta: {
    titulo: "Restrição ou violação na conta",
    acao: "A Meta restringiu a conta do WhatsApp. Veja o motivo no Gerenciador do WhatsApp antes de retomar.",
  },
  numero_qualidade_baixa: {
    titulo: "Qualidade do número baixa",
    acao:
      "A Meta marcou o número com qualidade baixa e pode reduzir o limite de envios. O recomendado é esperar a qualidade melhorar.",
  },
  saidas_acima_do_limite: {
    titulo: "Muitos pedidos para sair",
    acao:
      "Mais de 2% de quem recebeu pediu para não receber mais. Revise o público e a mensagem; ao retomar, a conta recomeça do zero.",
  },
};

export function ehMotivoDePausa(v: unknown): v is MotivoDePausa {
  return typeof v === "string" && (MOTIVOS_DE_PAUSA as readonly string[]).includes(v);
}
