"use client";

import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";

type Variant = "error" | "warning" | "info";

const COPY: Record<string, { variant: Variant; msg: string }> = {
  body_malformed: {
    variant: "error",
    msg: "Requisição inválida. Recarregue e tente de novo.",
  },
  cursor_malformed: {
    variant: "error",
    msg: "Falha ao paginar. Volte ao início.",
  },
  validation_error: {
    variant: "error",
    msg: "Dados inválidos. Confira os campos destacados.",
  },
  auth_required: {
    variant: "warning",
    msg: "Sessão expirada. Faça login novamente.",
  },
  forbidden_role: {
    variant: "warning",
    msg: "Você não tem permissão para esta ação.",
  },
  resource_not_found: {
    variant: "error",
    msg: "Recurso não encontrado ou já removido.",
  },
  tenant_not_found: {
    variant: "error",
    msg: "Organização não encontrada.",
  },
  idempotency_conflict: {
    variant: "warning",
    msg: "Operação já processada.",
  },
  conversation_already_claimed: {
    variant: "warning",
    msg: "Outro atendente já assumiu.",
  },
  invalid_state: {
    variant: "warning",
    msg: "Este caso já foi respondido ou fechado.",
  },
  rate_limited: {
    variant: "warning",
    msg: "Calma — muitas tentativas. Espere alguns segundos.",
  },
  lgpd_anonymization_irreversible: {
    variant: "error",
    msg: "Esta ação não pode ser desfeita: o contato já foi anonimizado.",
  },
  internal_error: {
    variant: "error",
    // Fallback só — `internal_error` é o balde genérico de VÁRIAS rotas
    // diferentes, cada uma escrevendo a própria mensagem específica (ex.:
    // "token vencido", o erro cru da Graph API). Sobrescrever por um texto
    // fixo aqui jogaria fora exatamente o que o operador precisa ler —
    // achado ao vivo: o erro real da Meta virava "tente de novo" na tela,
    // e nem o servidor logava, então o motivo verdadeiro ficava invisível
    // dos dois lados.
    msg: "Erro interno. Tente de novo em instantes.",
  },
};

export function showApiError(err: unknown): void {
  if (err instanceof ApiError) {
    const entry = COPY[err.code];
    const description = err.requestId ? `ID: ${err.requestId}` : undefined;
    if (entry) {
      const fn =
        entry.variant === "warning"
          ? toast.warning
          : entry.variant === "info"
            ? toast.info
            : toast.error;
      // `internal_error` é o único código genérico o bastante pra a mensagem
      // do SERVIDOR valer mais que o texto fixo — os outros códigos (sessão
      // expirada, sem permissão etc.) já são específicos por natureza, e o
      // texto fixo deles é a rejeição INTENCIONAL do jargão técnico do server.
      // `err.message === err.code` é o caso de `fail()` sem `message` real
      // (o construtor do ApiError cai pro código como texto) — aí o fixo
      // ainda vale, senão a tela mostraria o código cru "internal_error".
      const temMensagemReal = err.message && err.message !== err.code;
      const texto = err.code === "internal_error" && temMensagemReal ? err.message : entry.msg;
      fn(texto, { description });
      return;
    }
    toast.error(err.message || err.code, { description });
    return;
  }
  toast.error("Erro inesperado. Tente novamente.");
}

export function useApiErrorHandler(): (err: unknown) => void {
  return showApiError;
}
