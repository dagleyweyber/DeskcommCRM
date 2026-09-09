import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError } from "@/lib/api/types";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { showApiError } from "@/components/feedback/ApiErrorToast";

describe("ApiErrorToast", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it("has at least 10 entries in the COPY map (covered via known codes)", () => {
    const knownCodes = [
      "body_malformed",
      "cursor_malformed",
      "validation_error",
      "auth_required",
      "forbidden_role",
      "resource_not_found",
      "tenant_not_found",
      "idempotency_conflict",
      "conversation_already_claimed",
      "rate_limited",
      "lgpd_anonymization_irreversible",
      "internal_error",
    ];
    for (const code of knownCodes) {
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.warning).mockClear();
      vi.mocked(toast.info).mockClear();
      showApiError(new ApiError(400, code, undefined, "req-x"));
      const total =
        vi.mocked(toast.error).mock.calls.length +
        vi.mocked(toast.warning).mock.calls.length +
        vi.mocked(toast.info).mock.calls.length;
      expect(total).toBeGreaterThan(0);
    }
    expect(knownCodes.length).toBeGreaterThanOrEqual(10);
  });

  it("calls toast.warning with canonical PT-BR for conversation_already_claimed", () => {
    showApiError(new ApiError(409, "conversation_already_claimed", undefined, "req-1"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Outro atendente já assumiu.",
      expect.objectContaining({ description: "ID: req-1" }),
    );
  });

  it("calls toast.warning com mensagem humana para invalid_state (casos humanos, spec 15)", () => {
    showApiError(new ApiError(409, "invalid_state", undefined, "req-3"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Este caso já foi respondido ou fechado.",
      expect.objectContaining({ description: "ID: req-3" }),
    );
  });

  it("falls back to toast.error for unknown ApiError code", () => {
    const err = new ApiError(418, "unknown_teapot_code", undefined, "req-2", "I'm a teapot");
    showApiError(err);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "I'm a teapot",
      expect.objectContaining({ description: "ID: req-2" }),
    );
  });

  it("calls toast.error with generic message for non-ApiError", () => {
    showApiError(new Error("oops"));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Erro inesperado. Tente novamente.");
  });

  describe("internal_error — mensagem do SERVIDOR vale mais que o texto fixo", () => {
    it("⭐ mostra a mensagem real do erro (ex.: motivo da Graph API), não o texto genérico", () => {
      // Achado ao vivo: criar template de canal oficial falhava e a tela
      // sempre mostrava "Erro interno. Tente de novo em instantes." — sem
      // nenhuma pista do que a Meta realmente recusou. A rota já mandava o
      // motivo certo (`err.message`); só a tela jogava fora.
      showApiError(
        new ApiError(502, "internal_error", undefined, "req-4", "meta_400: nome já existe"),
      );
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        "meta_400: nome já existe",
        expect.objectContaining({ description: "ID: req-4" }),
      );
    });

    it("sem mensagem real (fail() chamado sem detalhe), cai pro texto fixo — nunca mostra o código cru", () => {
      // ApiError sem `message` usa o próprio `code` como Error.message —
      // sem esta guarda, o usuário leria "internal_error" na tela.
      showApiError(new ApiError(500, "internal_error", undefined, "req-5"));
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        "Erro interno. Tente de novo em instantes.",
        expect.objectContaining({ description: "ID: req-5" }),
      );
    });
  });
});
