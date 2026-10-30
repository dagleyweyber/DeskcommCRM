/**
 * Respostas rápidas no menu "+" do composer.
 *
 * Os scripts já existiam (tela "Respostas rápidas" e o atalho "/"), mas só quem
 * sabia digitar "/" chegava neles. O menu "+" é onde a atendente já procura
 * anexo — o item novo leva à MESMA lista.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { filtrarRespostas, RespostasRapidasDialog } from "@/components/inbox/composer/RespostasRapidasDialog";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

afterEach(cleanup);

const T: MessageTemplate[] = [
  { id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}, tudo bem?", shortcut: "oi", owner_user_id: null },
  { id: "2", title: "Valores", body: "O investimento inicial é de R$ 997,00.", shortcut: "preco", owner_user_id: null },
  { id: "3", title: "Endereço", body: "Ficamos na Av. Principal, 100", shortcut: null, owner_user_id: "u" },
];

describe("filtrarRespostas", () => {
  it("sem busca devolve tudo", () => {
    expect(filtrarRespostas(T, "  ")).toHaveLength(3);
  });

  it("⭐ acha pelo título, pelo atalho e pelo TEXTO, sem acento nem caixa", () => {
    expect(filtrarRespostas(T, "saudacao").map((t) => t.id)).toEqual(["1"]);
    expect(filtrarRespostas(T, "PRECO").map((t) => t.id)).toEqual(["2"]);
    expect(filtrarRespostas(T, "investimento").map((t) => t.id)).toEqual(["2"]);
    expect(filtrarRespostas(T, "av. principal").map((t) => t.id)).toEqual(["3"]);
  });

  it("nada encontrado → lista vazia", () => {
    expect(filtrarRespostas(T, "zzz")).toEqual([]);
  });
});

describe("AttachMenu — item Respostas rápidas", () => {
  it("⭐ o item aparece no menu e abre as respostas (fechando o menu)", () => {
    const abrir = vi.fn();
    render(<AttachMenu onPick={() => {}} onRespostasRapidas={abrir} />);
    fireEvent.click(screen.getByLabelText("Anexar"));
    fireEvent.click(screen.getByText("Respostas rápidas"));
    expect(abrir).toHaveBeenCalledTimes(1);
    // o menu fecha: o item some e Fotos/Documento junto
    expect(screen.queryByText("Fotos e vídeos")).not.toBeInTheDocument();
  });

  it("sem o handler, o menu segue como antes (só Fotos e vídeos / Documento)", () => {
    render(<AttachMenu onPick={() => {}} />);
    fireEvent.click(screen.getByLabelText("Anexar"));
    expect(screen.getByText("Fotos e vídeos")).toBeInTheDocument();
    expect(screen.getByText("Documento")).toBeInTheDocument();
    expect(screen.queryByText("Respostas rápidas")).not.toBeInTheDocument();
  });
});

describe("RespostasRapidasDialog", () => {
  it("⭐ escolher uma resposta devolve o template", () => {
    const onPick = vi.fn();
    render(<RespostasRapidasDialog open onOpenChange={() => {}} templates={T} onPick={onPick} />);
    fireEvent.click(screen.getByText("Valores"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });

  it("a busca filtra a lista", () => {
    render(<RespostasRapidasDialog open onOpenChange={() => {}} templates={T} onPick={() => {}} />);
    fireEvent.change(screen.getByLabelText("Buscar resposta rápida"), { target: { value: "endereco" } });
    expect(screen.getByText("Endereço")).toBeInTheDocument();
    expect(screen.queryByText("Valores")).not.toBeInTheDocument();
  });

  it("sem nenhuma resposta cadastrada, manda criar a primeira (não fica mudo)", () => {
    render(<RespostasRapidasDialog open onOpenChange={() => {}} templates={[]} onPick={() => {}} />);
    expect(screen.getByText(/Nenhuma resposta rápida ainda/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crie a primeira" })).toHaveAttribute("href", "/app/templates");
  });

  it("busca sem resultado diz isso, em vez de mandar criar", () => {
    render(<RespostasRapidasDialog open onOpenChange={() => {}} templates={T} onPick={() => {}} />);
    fireEvent.change(screen.getByLabelText("Buscar resposta rápida"), { target: { value: "zzz" } });
    expect(screen.getByText("Nenhuma resposta encontrada para essa busca.")).toBeInTheDocument();
  });
});
