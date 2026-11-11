import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Excluir" na lista de automações. O que o teste trava:
 *   - excluir PEDE confirmação (um clique solto não pode tirar a automação do ar);
 *   - o texto diz o que acontece de verdade — para de enviar, histórico mantido — e avisa quando
 *     a automação está ATIVA;
 *   - só o "Excluir automação" do diálogo chama a API, com o id certo.
 */

const excluir = vi.fn();
let lista: unknown[] = [];

vi.mock("@/hooks/campaigns/useAutomations", () => ({
  useAutomations: () => ({ data: { data: { automations: lista } }, isPending: false }),
  useAutomation: () => ({ data: undefined, isPending: true, isError: false }),
  useActivateAutomation: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseAutomation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAutomation: () => ({ mutate: excluir, isPending: false }),
}));
vi.mock("@/app/app/campaigns/_components/NovaAutomacaoForm", () => ({
  AutomacaoForm: () => null,
  NovaAutomacaoForm: () => null,
  rotuloDoMomento: () => "1 dia antes",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AutomacoesClient } from "@/app/app/campaigns/_components/AutomacoesClient";

const automacao = (extra: Record<string, unknown> = {}) => ({
  id: "auto-1",
  name: "Confirmação Agendamento Laser",
  trigger_kind: "appointment_reminder",
  status: "paused",
  template_name: "lembrete_agendamento_laser",
  template_language: "pt_BR",
  event_type_id: null,
  event_type: null,
  timing_kind: "days_before",
  timing_value: 1,
  confirm_button_text: null,
  decline_button_text: null,
  created_at: "2026-10-26T00:00:00Z",
  updated_at: "2026-10-26T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  excluir.mockReset();
  lista = [automacao()];
});

describe("Excluir automação", () => {
  it("⭐ o botão só abre a confirmação — não chama a API", () => {
    render(<AutomacoesClient />);
    fireEvent.click(screen.getByTestId("automacao-excluir"));
    expect(screen.getByText(/Excluir a automação/)).toBeTruthy();
    expect(excluir).not.toHaveBeenCalled();
  });

  it("⭐ o texto diz a verdade: some e não envia, o histórico é mantido e as respostas continuam valendo", () => {
    render(<AutomacoesClient />);
    fireEvent.click(screen.getByTestId("automacao-excluir"));
    expect(screen.getByText(/não envia mais nada/)).toBeTruthy();
    expect(screen.getByText(/histórico de envios é mantido/)).toBeTruthy();
    expect(screen.queryByText(/deixa de enviar agora/)).toBeNull(); // pausada: sem o aviso de ativa
  });

  it("automação ATIVA avisa que deixa de enviar agora", () => {
    lista = [automacao({ status: "active" })];
    render(<AutomacoesClient />);
    fireEvent.click(screen.getByTestId("automacao-excluir"));
    expect(screen.getByText(/deixa de enviar agora/)).toBeTruthy();
  });

  it("⭐ confirmar chama a API com o id da automação", () => {
    render(<AutomacoesClient />);
    fireEvent.click(screen.getByTestId("automacao-excluir"));
    fireEvent.click(screen.getByTestId("automacao-excluir-confirmar"));
    expect(excluir).toHaveBeenCalledTimes(1);
    expect(excluir.mock.calls[0]![0]).toBe("auto-1");
  });

  it("“Manter” fecha sem excluir", () => {
    render(<AutomacoesClient />);
    fireEvent.click(screen.getByTestId("automacao-excluir"));
    fireEvent.click(screen.getByText("Manter"));
    expect(excluir).not.toHaveBeenCalled();
  });
});
