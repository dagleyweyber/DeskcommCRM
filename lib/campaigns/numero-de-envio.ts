/**
 * Escolha do NÚMERO de envio na hora de criar uma campanha (ou automação).
 *
 * Uma organização pode ter mais de um número oficial. Até aqui o formulário usava o primeiro
 * que existisse, calado: com dois números, toda campanha saía pelo mais antigo e a lista de
 * modelos era a dele. Regras desta peça, puras (sem tela, sem banco):
 *
 *   - UM número conectado → é ele, sem perguntar (nada a decidir);
 *   - DOIS ou mais → ninguém é escolhido por padrão: o operador decide, olhando a saúde de cada
 *     um. Pré-selecionar o "primeiro" era exatamente o defeito;
 *   - a saúde do número vira aviso ANTES de criar, não depois de o freio da campanha parar.
 */

export interface NumeroDeEnvio {
  id: string;
  nome: string;
  conectado: boolean;
  /** Nota da Meta: GREEN, YELLOW, RED; `null` = ainda não informada. */
  qualidade: string | null;
  /** TIER_250, TIER_1K…; `null` = a Meta não informou. */
  limite: string | null;
}

/** TIER_1K → "até 1.000 contatos diferentes a cada 24 h". */
export function textoDoLimite(limite: string | null): string | null {
  if (!limite) return null;
  if (limite.toUpperCase() === "TIER_UNLIMITED") return "sem limite diário de contatos";
  const m = /^TIER_(\d+)(K)?$/i.exec(limite);
  if (!m) return limite;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return `até ${n.toLocaleString("pt-BR")} contatos diferentes a cada 24 h`;
}

const QUALIDADE_CURTA: Record<string, string> = { GREEN: "qualidade alta", YELLOW: "qualidade média", RED: "qualidade baixa" };

/** "Loja Centro — qualidade média · até 1.000 contatos por dia" — uma linha por opção do seletor. */
export function rotuloDoNumero(n: NumeroDeEnvio): string {
  const partes = [
    n.conectado ? null : "desconectado",
    n.qualidade ? (QUALIDADE_CURTA[n.qualidade.toUpperCase()] ?? null) : null,
    n.limite ? textoDoLimite(n.limite)?.replace("contatos diferentes a cada 24 h", "contatos por dia") ?? null : null,
  ].filter(Boolean);
  return partes.length > 0 ? `${n.nome} — ${partes.join(" · ")}` : n.nome;
}

/**
 * Qual número já vem escolhido: só quando há UM número (nada a decidir — se estiver desconectado,
 * o aviso dele bloqueia). Com mais de um, `null`: a escolha é do operador, e pré-selecionar o
 * "primeiro" era justamente o defeito.
 */
export function numeroInicial(numeros: readonly NumeroDeEnvio[]): string | null {
  return numeros.length === 1 ? numeros[0]!.id : null;
}

export interface AvisoDoNumero {
  /** `bloqueio` impede criar; `risco` deixa criar mas diz o que vai acontecer. */
  nivel: "bloqueio" | "risco" | "atencao";
  texto: string;
}

export function avisoDoNumero(n: NumeroDeEnvio | null | undefined): AvisoDoNumero | null {
  if (!n) return null;
  if (!n.conectado) {
    return {
      nivel: "bloqueio",
      texto: "Este número está desconectado. Reconecte em Conexões antes de criar a campanha.",
    };
  }
  const nota = n.qualidade?.toUpperCase();
  if (nota === "RED") {
    return {
      nivel: "risco",
      texto:
        "A Meta marcou este número com qualidade BAIXA. A campanha para sozinha assim que começar a enviar, e disparar assim pode reduzir o limite do número. O recomendado é esperar a qualidade melhorar ou usar outro número.",
    };
  }
  if (nota === "YELLOW") {
    return {
      nivel: "atencao",
      texto:
        "Este número está com qualidade MÉDIA: muita gente tem bloqueado ou ignorado as mensagens. Prefira uma campanha menor, com espera entre blocos.",
    };
  }
  return null;
}
