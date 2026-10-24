/**
 * Ativa uma sessão em coexistência: assina a WABA (recebimento) e só então pede à
 * Meta a agenda e o histórico do app.
 *
 * Existe como função única porque DOIS caminhos precisam do mesmo comportamento: a
 * conclusão do Embedded Signup e a REATIVAÇÃO de uma conexão que ficou pela metade.
 * A primeira conexão real mostrou o porquê — a assinatura falhou, a rota parou ali, e
 * os pedidos de histórico nunca saíram, com a janela de 24h da Meta correndo. Duas
 * cópias desta sequência divergiriam; uma só, não.
 *
 * ─── A ordem é a regra ─────────────────────────────────────────────────────
 * 1. Assinar a WABA. SEM recebimento ativo, o histórico que a Meta entregar depois
 *    cai num webhook que ninguém ouve, e o pedido (que vale UMA vez) é gasto.
 * 2. Só se (1) deu certo: pedir agenda e histórico. Falha em (1) NÃO pede nada — o
 *    pedido continua disponível para a reativação.
 */
import {
  pedirSincronizacao,
  subscribeWabaComOverride,
  type TipoDeSincronizacao,
} from "./embedded-signup";

export type ResultadoSincronizacao = { ok: boolean; motivo?: string; requestId?: string | null };

export type ResultadoAtivacao =
  | { ok: true; sync: Record<TipoDeSincronizacao, ResultadoSincronizacao> }
  | { ok: false; etapa: "assinatura"; motivo: string };

export async function ativarCoexistencia(input: {
  wabaId: string;
  phoneNumberId: string;
  token: string;
  callbackUri: string;
  verifyToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ResultadoAtivacao> {
  const assinatura = await subscribeWabaComOverride({
    wabaId: input.wabaId,
    token: input.token,
    callbackUri: input.callbackUri,
    verifyToken: input.verifyToken,
    fetchImpl: input.fetchImpl,
  });
  if (!assinatura.ok) return { ok: false, etapa: "assinatura", motivo: assinatura.motivo };

  const sync = {} as Record<TipoDeSincronizacao, ResultadoSincronizacao>;
  for (const tipo of ["smb_app_state_sync", "history"] as const) {
    const r = await pedirSincronizacao({
      phoneNumberId: input.phoneNumberId,
      token: input.token,
      tipo,
      fetchImpl: input.fetchImpl,
    });
    sync[tipo] = r.ok ? { ok: true, requestId: r.requestId } : { ok: false, motivo: r.motivo };
  }
  return { ok: true, sync };
}
