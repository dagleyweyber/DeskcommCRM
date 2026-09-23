/**
 * Achado ao vivo (RevitaFio Mossoró): 3 leads criados pelo "+ Novo lead" da
 * Kanban com telefone preenchido nasceram SEM `contact_id` — sem erro, sem
 * aviso, o toast dizia "Lead criado" normalmente. A campanha "por etapa do
 * funil" depois não achava nenhum dos 3 (sem contato, sem telefone pra
 * resolver).
 *
 * Causa raiz: `POST /api/v1/contacts` devolve `data: { contact, action }` —
 * não o Contact direto (é o mesmo contrato que os e2e já usam via
 * `data.contact.id`, ver `contato-salva-email.spec.ts`). Este diálogo lia
 * `res.data.id`, que é sempre `undefined` nesse formato — silencioso porque
 * `if (resolvedContactId) payload.contact_id = ...` some sozinho quando falso,
 * sem sobrar rastro nenhum pro usuário perceber.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { Stage } from "@/lib/kanban/types";
import { NewLeadDialog } from "./NewLeadDialog";

const criarLead = vi.fn();
const criarContato = vi.fn();

vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));
vi.mock("@/hooks/contacts/useCreateContact", () => ({
  useCreateContact: () => ({ mutateAsync: criarContato, isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/pipelines/useServiceOptions", () => ({
  useServiceOptions: () => ({ data: undefined }),
}));

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

const STAGES: Stage[] = [
  {
    id: STAGE_ID,
    organization_id: "org",
    pipeline_id: PIPELINE_ID,
    name: "Novo",
    slug: "novo",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  },
];

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewLeadDialog open onOpenChange={() => {}} pipelineId={PIPELINE_ID} stages={STAGES} />
    </QueryClientProvider>,
  );
}

describe("NewLeadDialog — telefone digitado precisa virar contact_id do lead", () => {
  beforeEach(() => {
    criarLead.mockReset();
    criarContato.mockReset();
    criarLead.mockResolvedValue({ data: { id: "lead-1" } });
  });

  it("⭐ envia contact_id do contato recém-criado — não `undefined` por ler o campo errado", async () => {
    // O formato REAL da resposta: `data.contact`, não `data` direto.
    criarContato.mockResolvedValue({ data: { contact: { id: CONTACT_ID }, action: "created" } });

    const user = userEvent.setup({ delay: null });
    montar();

    await user.type(screen.getByLabelText("Título"), "Francisco");
    await user.type(screen.getByLabelText("Telefone"), "(84) 92145-4902");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    expect(await screen.findByText("Criar lead")).toBeInTheDocument();
    expect(criarLead).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: CONTACT_ID }),
    );
  });

  it("sem telefone nem e-mail, não tenta criar contato — lead nasce sem contact_id mesmo (esperado)", async () => {
    const user = userEvent.setup({ delay: null });
    montar();

    await user.type(screen.getByLabelText("Título"), "Card manual sem contato");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await screen.findByText("Criar lead");
    expect(criarContato).not.toHaveBeenCalled();
    expect(criarLead).toHaveBeenCalledWith(
      expect.not.objectContaining({ contact_id: expect.anything() }),
    );
  });
});

/**
 * Achado ao vivo (RevitaFio Mossoró, mesmo caso do Francisco/Filgueira Neto):
 * dois leads nasceram pro mesmo contato no mesmo pipeline, ~2h de diferença —
 * o "+ Novo lead" nunca checava se o contato já tinha um aberto. O servidor
 * agora recusa com `duplicate_open_lead`; a tela precisa virar isso num
 * aviso com "Criar mesmo assim", não um erro mudo.
 */
describe("NewLeadDialog — aviso de lead duplicado (contato já tem um aberto neste pipeline)", () => {
  beforeEach(() => {
    criarLead.mockReset();
    criarContato.mockReset();
  });

  it("⭐ mostra o aviso com o título do lead existente, e não reseta o formulário", async () => {
    criarLead.mockRejectedValueOnce(
      new ApiError(
        409,
        "duplicate_open_lead",
        { existing_lead_id: "lead-existente", existing_lead_title: "Francisco" },
        "req-1",
        'Este contato já tem um lead aberto neste pipeline: "Francisco".',
      ),
    );

    const user = userEvent.setup({ delay: null });
    montar();

    await user.type(screen.getByLabelText("Título"), "Filgueira Neto");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    const aviso = await screen.findByTestId("aviso-lead-duplicado");
    expect(aviso).toHaveTextContent("Francisco");
    // O formulário continua preenchido — a pessoa não perde o que digitou
    // por causa de um aviso que ela ainda vai decidir o que fazer.
    expect(screen.getByLabelText("Título")).toHaveValue("Filgueira Neto");
  });

  it("⭐ «Criar mesmo assim» reenvia com confirm_duplicate — sem recriar o contato", async () => {
    criarContato.mockResolvedValue({
      data: { contact: { id: "contato-1" }, action: "created" },
    });
    criarLead
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "duplicate_open_lead",
          { existing_lead_id: "lead-existente", existing_lead_title: "Francisco" },
          "req-1",
        ),
      )
      .mockResolvedValueOnce({ data: { id: "lead-novo" } });

    const user = userEvent.setup({ delay: null });
    montar();

    await user.type(screen.getByLabelText("Título"), "Filgueira Neto");
    await user.type(screen.getByLabelText("Telefone"), "(84) 92145-4902");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await screen.findByTestId("aviso-lead-duplicado");

    expect(criarContato).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Criar mesmo assim" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(2));
    expect(criarLead).toHaveBeenLastCalledWith(
      expect.objectContaining({ contact_id: "contato-1", confirm_duplicate: true }),
    );
    // Reenviar não pede o contato de novo — reusa o que já foi resolvido.
    expect(criarContato).toHaveBeenCalledTimes(1);
  });

  it("submeter de novo (não «Criar mesmo assim») some com o aviso anterior", async () => {
    criarLead
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "duplicate_open_lead",
          { existing_lead_id: "lead-existente", existing_lead_title: "Francisco" },
          "req-1",
        ),
      )
      .mockResolvedValueOnce({ data: { id: "lead-novo" } });

    const user = userEvent.setup({ delay: null });
    montar();

    await user.type(screen.getByLabelText("Título"), "Tentativa 1");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await screen.findByTestId("aviso-lead-duplicado");

    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() =>
      expect(screen.queryByTestId("aviso-lead-duplicado")).not.toBeInTheDocument(),
    );
  });
});
