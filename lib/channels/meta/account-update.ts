/**
 * `account_update` da Meta → o que a clínica precisa saber.
 *
 * Puro: recebe o evento, devolve a SAÚDE observada do canal (`WORKING`/`FAILED`/
 * `STOPPED`, que o trilho de `lib/channels/health.ts` transforma em aviso único por
 * episódio e resolve quando volta) e/ou um AVISO avulso na Central.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 * Em coexistência o número vive em dois lugares, e a Meta desliga a Cloud API por
 * motivos que o CRM nunca via: o celular ficou ~14 dias sem uso, o dono trocou de
 * número, desinstalou o app, a conta foi restringida ou banida. Sem estes avisos o
 * canal ficava "Conectado" na tela e simplesmente parava — a clínica só descobria
 * quando um cliente reclamava.
 *
 * ─── O critério de gravidade (o mesmo do canal intermediado) ───────────────
 * Cai de verdade (nenhuma mensagem entra nem sai) → saúde. Pede atenção sem parar
 * nada → só aviso. Marcar tudo como queda faria a faixa vermelha acender num canal
 * que está mandando mensagem, e o operador aprenderia a ignorá-la.
 */
import type { SaudeObservada } from "../health";
import type { AvisoDeCanal } from "../zernio/avisos";
import type { AccountUpdateEvent } from "./coexistence-webhook";

/** Motivo de desconexão (`disconnection_info.reason`) em português de recepção. */
const MOTIVO_DA_DESCONEXAO: Record<string, string> = {
  PRIMARY_INACTIVITY:
    "O celular com o app WhatsApp Business ficou cerca de 14 dias sem uso. Abra o app no celular e reconecte o número.",
  COMPANION_INACTIVITY:
    "Um aparelho pareado ficou cerca de 30 dias sem uso e a Meta desligou a conexão.",
  CHANGE_NUMBER: "O número foi trocado no WhatsApp.",
  USER_RE_REGISTERED: "O número foi registrado novamente em outro aparelho ou app.",
};

function textoDoMotivo(e: AccountUpdateEvent): string | null {
  const base = e.disconnectReason ? MOTIVO_DA_DESCONEXAO[e.disconnectReason] : undefined;
  const quem =
    e.disconnectInitiatedBy === "USER"
      ? "Desconectado pelo próprio cliente."
      : e.disconnectInitiatedBy === "SYSTEM"
        ? "Desconectado automaticamente pela Meta."
        : null;
  const partes = [base ?? (e.disconnectReason ? `Motivo informado pela Meta: ${e.disconnectReason}.` : null), quem];
  const texto = partes.filter(Boolean).join(" ");
  return texto || null;
}

/** A conexão em si: caiu, está parada ou voltou? `null` quando o evento não fala disso. */
export function saudeDoAccountUpdate(e: AccountUpdateEvent): SaudeObservada | null {
  switch (e.event) {
    // A conta deixou de existir para o CRM: o operador precisa reconectar.
    case "PARTNER_REMOVED":
    case "PARTNER_APP_UNINSTALLED":
    case "ACCOUNT_OFFBOARDED":
    case "ACCOUNT_DELETED":
      return { reachable: true, status: "STOPPED", detail: e.event };

    // Banida ou em vias de ser: não manda mensagem.
    case "DISABLED_UPDATE":
      if (e.banState === "REINSTATE") return { reachable: true, status: "WORKING", detail: null };
      if (e.banState === "DISABLE" || e.banState === "SCHEDULE_FOR_DISABLE") {
        return { reachable: true, status: "FAILED", detail: `${e.event}:${e.banState}` };
      }
      return null;

    case "ACCOUNT_VIOLATION":
      return { reachable: true, status: "FAILED", detail: e.event };

    // O canal está de pé de novo. É o que fecha o episódio aberto.
    case "ACCOUNT_RECONNECTED":
      return { reachable: true, status: "WORKING", detail: null };

    // `ACCOUNT_RESTRICTION` restringe (ex.: não iniciar conversas) mas não derruba o
    // envio: vira aviso, não queda — ver `avisoDoAccountUpdate`.
    default:
      return null;
  }
}

/**
 * Aviso avulso. Só para o que pede atenção SEM ser uma queda — as quedas já viram
 * aviso pelo trilho de saúde, e um aviso aqui também mostraria o mesmo problema duas
 * vezes na Central.
 */
export function avisoDoAccountUpdate(e: AccountUpdateEvent): AvisoDeCanal | null {
  if (e.event === "ACCOUNT_RESTRICTION") {
    return {
      kind: "channel_number_alert",
      severity: "warn",
      title: "A Meta aplicou uma restrição à conta de WhatsApp",
      body: e.restrictionType
        ? `Tipo de restrição: ${e.restrictionType}. Veja o Gerenciador do WhatsApp para a ação recomendada.`
        : "Veja o Gerenciador do WhatsApp para a ação recomendada.",
    };
  }
  return null;
}

/** Texto extra para o corpo do aviso de desconexão (o trilho de saúde usa um genérico). */
export function detalheDaDesconexao(e: AccountUpdateEvent): string | null {
  return e.event === "PARTNER_REMOVED" ? textoDoMotivo(e) : null;
}
