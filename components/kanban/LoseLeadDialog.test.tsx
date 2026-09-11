/**
 * Achado ao vivo (B'Laser Caruaru), em duas partes:
 *
 * 1. O operador cadastrava os motivos de perda do pipeline em
 *    Configurações › Funis, e o diálogo "Marcar como perdido" continuava
 *    mostrando só os 8 códigos canônicos — a extensão nunca chegava até
 *    aqui. O backend (`fn_validate_lost_reason_required`) já aceitava a
 *    extensão; faltava só a TELA oferecer.
 * 2. Depois de ligar as duas, um pipeline QUE JÁ CURA os próprios motivos
 *    passou a ver as duas listas juntas — poluído, e com "Preço"
 *    (canônico) duplicado ao lado do "Preço" que ele mesmo cadastrou. A
 *    lista visível virou um `<Select>` (era uma pilha de rádios) e, com
 *    extensão presente, é SÓ a extensão — os 7 canônicos somem.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoseLeadDialog } from "./LoseLeadDialog";

const perder = vi.fn();
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: perder, isPending: false }),
}));

async function abrirOMenu() {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("combobox", { name: "Motivo" }));
  return user;
}

describe("LoseLeadDialog — extensão curada do pipeline", () => {
  beforeEach(() => perder.mockReset());

  it("sem extensão, oferece só os 8 canônicos (comportamento de hoje preservado)", async () => {
    render(<LoseLeadDialog open onOpenChange={() => {}} leadId="lead-1" pipelineId="pipe-1" />);
    await abrirOMenu();

    expect(screen.getByRole("option", { name: "Preço" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Outro motivo" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  it("⭐ COM extensão, é SÓ a extensão + 'Outro motivo' — os canônicos não poluem mais a lista", async () => {
    render(
      <LoseLeadDialog
        open
        onOpenChange={() => {}}
        leadId="lead-1"
        pipelineId="pipe-1"
        extraReasons={["Não tem cartão", "Mora fora"]}
      />,
    );
    await abrirOMenu();

    expect(screen.getByRole("option", { name: "Não tem cartão" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Mora fora" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Outro motivo" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Preço" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("⭐ entrada repetida no cadastro (o caso real) não vira opção duplicada", async () => {
    render(
      <LoseLeadDialog
        open
        onOpenChange={() => {}}
        leadId="lead-1"
        pipelineId="pipe-1"
        extraReasons={["Preço", "Mora fora", "Preço"]}
      />,
    );
    await abrirOMenu();

    expect(screen.getAllByRole("option", { name: "Preço" })).toHaveLength(1);
  });

  it("⭐ selecionar o motivo extra manda o TEXTO em si pro backend — não 'other'", async () => {
    render(
      <LoseLeadDialog
        open
        onOpenChange={() => {}}
        leadId="lead-1"
        pipelineId="pipe-1"
        extraReasons={["Não tem cartão"]}
      />,
    );
    const user = await abrirOMenu();

    await user.click(screen.getByRole("option", { name: "Não tem cartão" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(perder).toHaveBeenCalledWith({ leadId: "lead-1", lostReason: "Não tem cartão" });
  });
});
