import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * QUEM assumiu a conversa, na lista lateral do inbox.
 *
 * Pedido do dono da agência: admin e outros atendentes verem quem está
 * conduzindo cada conversa sem abrir uma a uma. Mesma classe de prova de
 * `inbox-por-onde-entrou.test.tsx` (canal por conversa) — metade dos casos
 * prova quando o nome NÃO aparece, porque um badge que nunca some é ruído.
 */
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "claimed",
  last_message_at: new Date().toISOString(),
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: new Date().toISOString(),
  contacts: {
    id: "ct1",
    display_name: "Cliente",
    name: null,
    phone_number: "+595999",
    tags: [],
    is_blocked: false,
    is_anonymized: false,
  },
} as unknown as ConversationWithContact;

const pintar = (assigneeName: string | null | undefined) =>
  render(
    <ConversationListItem
      conversation={base}
      isSelected={false}
      onSelect={() => {}}
      assigneeName={assigneeName}
    />,
  );

describe("mostra quem assumiu", () => {
  it("⭐ pinta o nome do atendente quando presente", () => {
    pintar("Ana França Sobral");
    expect(screen.getByText("Ana França Sobral")).toBeInTheDocument();
  });

  it("explica no title — o nome sozinho não diz que é atendimento", () => {
    pintar("Ana França Sobral");
    expect(screen.getByTitle("Assumida por Ana França Sobral")).toBeInTheDocument();
  });
});

describe("NÃO mostra quando não ajuda", () => {
  it("ninguém assumiu (null) — sem badge vazio", () => {
    pintar(null);
    expect(screen.queryByTitle(/Assumida por/)).not.toBeInTheDocument();
  });

  it("prop ausente não quebra a linha", () => {
    expect(() => pintar(undefined)).not.toThrow();
    expect(screen.getByText("Cliente")).toBeInTheDocument();
  });
});

describe("o elo que some sem barulho", () => {
  it("a lista resolve uuid→nome e filtra IA — sem isso o badge nunca tem o que mostrar, ou mostra o nome errado", () => {
    // Mesma classe de defeito do canal: o componente pode estar perfeito e o
    // nome nunca chegar, porque quem monta a lista não fez a ponte.
    const fonte = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    expect(fonte, "falta useAssignableMembers").toContain("useAssignableMembers");
    expect(fonte, "não filtra por assignee_kind === 'user' — vazaria nome em conversa da IA").toMatch(
      /assignee_kind\s*===\s*["']user["']/,
    );
  });
});
