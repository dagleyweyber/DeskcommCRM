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
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
