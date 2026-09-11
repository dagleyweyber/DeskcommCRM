/**
 * Achado ao vivo (B'Laser Caruaru): o operador cadastrava os motivos de
 * perda do pipeline em Configurações › Funis, e o diálogo "Marcar como
 * perdido" continuava mostrando só os 8 códigos canônicos — a extensão
 * nunca chegava até aqui. O backend (`fn_validate_lost_reason_required`)
 * já aceitava a extensão; faltava só a TELA oferecer.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoseLeadDialog } from "./LoseLeadDialog";

const perder = vi.fn();
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: perder, isPending: false }),
}));

describe("LoseLeadDialog — extensão curada do pipeline aparece como opção", () => {
  beforeEach(() => perder.mockReset());

  it("⭐ oferece o motivo extra, entre os canônicos e 'Outro motivo'", () => {
    render(
      <LoseLeadDialog
        open
        onOpenChange={() => {}}
        leadId="lead-1"
        pipelineId="pipe-1"
        extraReasons={["Não tem cartão", "Mora fora"]}
      />,
    );

    expect(screen.getByText("Preço")).toBeInTheDocument();
    expect(screen.getByText("Não tem cartão")).toBeInTheDocument();
    expect(screen.getByText("Mora fora")).toBeInTheDocument();
    expect(screen.getByText("Outro motivo")).toBeInTheDocument();
  });

  it("⭐ selecionar o motivo extra manda o TEXTO em si pro backend — não 'other'", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LoseLeadDialog
        open
        onOpenChange={() => {}}
        leadId="lead-1"
        pipelineId="pipe-1"
        extraReasons={["Não tem cartão"]}
      />,
    );

    await user.click(screen.getByText("Não tem cartão"));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(perder).toHaveBeenCalledWith({ leadId: "lead-1", lostReason: "Não tem cartão" });
  });

  it("sem extraReasons, comportamento de hoje é preservado (só os canônicos)", () => {
    render(
      <LoseLeadDialog open onOpenChange={() => {}} leadId="lead-1" pipelineId="pipe-1" />,
    );
    expect(screen.getByText("Preço")).toBeInTheDocument();
    expect(screen.getByText("Outro motivo")).toBeInTheDocument();
  });
});
