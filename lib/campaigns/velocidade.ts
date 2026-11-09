/**
 * Velocidade do disparo de uma campanha, escolhida na hora de criar.
 *
 * O ritmo de hoje (1 mensagem, pausa de 5 s) nasceu do canal não oficial, onde número demais
 * mandando rápido é banimento. Na API oficial o limite real é outro — o teto de contatos por 24 h do
 * nível do número e a qualidade —, então quem sabe que o número aguenta pode escolher mais.
 * O padrão continua sendo o ritmo antigo: campanha sem escolha anda como sempre andou.
 *
 * ⚠️ A FORMA de `VELOCIDADES_DA_CAMPANHA` é requisito de instrumento: o par `whatsapp_campaigns.velocidade`
 * de `tests/invariants/vocabulario-banco-x-typescript.test.ts` lê `const X = [...] as const`.
 */
import { CAMPAIGN_SEND_SPACING_MS } from "@/lib/automation/throttle";

export const VELOCIDADES_DA_CAMPANHA = ["cuidadosa", "normal", "rapida"] as const;
export type VelocidadeDaCampanha = (typeof VELOCIDADES_DA_CAMPANHA)[number];

export const VELOCIDADE_PADRAO: VelocidadeDaCampanha = "cuidadosa";

export interface RitmoDeEnvio {
  /** Quantas mensagens saem ao mesmo tempo a cada rodada. */
  lote: number;
  /** Pausa entre uma rodada e a próxima. */
  pausaMs: number;
  /** Estimativa para a tela (cada rodada também gasta ~1 s falando com a Meta). */
  porHora: number;
  rotulo: string;
}

export const RITMOS: Record<VelocidadeDaCampanha, RitmoDeEnvio> = {
  cuidadosa: { lote: 1, pausaMs: CAMPAIGN_SEND_SPACING_MS, porHora: 240, rotulo: "Cuidadosa" },
  normal: { lote: 2, pausaMs: 1000, porHora: 1200, rotulo: "Normal" },
  rapida: { lote: 5, pausaMs: 500, porHora: 3900, rotulo: "Rápida" },
};

/** Quantas falhas seguidas bastam para a campanha desacelerar até o fim da rodada do minuto. */
export const FALHAS_SEGUIDAS_PARA_FREAR = 3;

/** Valor desconhecido (linha antiga, coluna nula) anda no ritmo cuidadoso, nunca no mais rápido. */
export function ritmoDe(velocidade: string | null | undefined): RitmoDeEnvio {
  return RITMOS[(VELOCIDADES_DA_CAMPANHA as readonly string[]).includes(velocidade ?? "")
    ? (velocidade as VelocidadeDaCampanha)
    : VELOCIDADE_PADRAO];
}
