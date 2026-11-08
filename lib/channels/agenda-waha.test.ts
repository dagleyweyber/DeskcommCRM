import { describe, expect, it, vi } from "vitest";

import { WahaStoreDesligadoError } from "@/lib/waha/client";

import { AgendaGrandeDemaisError, AgendaIndisponivelError } from "./agenda";
import { carregarAgendaDaSessao, consolidarAgenda } from "./agenda-waha";

describe("consolidarAgenda", () => {
  it("⭐ separa quem está salvo na agenda de quem só conversou", () => {
    const r = consolidarAgenda(
      [{ id: "5581999990001@c.us", name: "Maria Silva", pushname: "Mari", isMyContact: true }],
      [
        { id: "5581999990001@c.us", name: "Mari" },
        { id: "5581999990002@c.us", name: "Desconhecido Fulano" },
      ],
    );
    expect(r.linhas).toEqual([
      { nome: "Desconhecido Fulano", telefone: "+5581999990002", salvo: false, nome_no_whatsapp: "Desconhecido Fulano" },
      { nome: "Maria Silva", telefone: "+5581999990001", salvo: true, nome_no_whatsapp: "Mari" },
    ]);
  });

  it("sem o campo isMyContact, ter nome na agenda conta como salvo", () => {
    const r = consolidarAgenda([{ id: "5581999990003@c.us", name: "João" }], []);
    expect(r.linhas[0]?.salvo).toBe(true);
    const sem = consolidarAgenda([{ id: "5581999990004@c.us", pushname: "Zé" }], []);
    expect(sem.linhas[0]?.salvo).toBe(false);
  });

  it("isMyContact=false vence o nome: quem não está na agenda não vira 'salvo'", () => {
    const r = consolidarAgenda(
      [{ id: "5581999990005@c.us", name: "Alguém", isMyContact: false }],
      [],
    );
    expect(r.linhas[0]?.salvo).toBe(false);
  });

  it("⭐ ignora grupo, lista de transmissão e canal — não são pessoas", () => {
    const r = consolidarAgenda(
      [
        { id: "120363000000000000@g.us", name: "Grupo" },
        { id: "status@broadcast" },
        { id: "123@newsletter" },
        { id: "5581999990006@c.us", name: "Pessoa", isGroup: false },
        { id: "5581999990007@c.us", name: "Marcado como grupo", isGroup: true },
      ],
      [{ id: "120363111111111111@g.us", name: "Outro grupo" }],
    );
    expect(r.linhas.map((l) => l.telefone)).toEqual(["+5581999990006"]);
  });

  it("⭐ não repete a mesma pessoa que aparece em contatos e em conversas", () => {
    const r = consolidarAgenda(
      [{ id: "5581999990008@c.us", name: "Ana", isMyContact: true }],
      [{ id: "5581999990008@c.us", name: "Ana (conversa)" }],
    );
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]?.nome).toBe("Ana");
  });

  it("a conversa só completa o nome que o contato não tinha", () => {
    const r = consolidarAgenda(
      [{ id: "5581999990009@c.us", isMyContact: false }],
      [{ id: "5581999990009@c.us", name: "Nome da conversa" }],
    );
    expect(r.linhas[0]?.nome).toBe("Nome da conversa");
  });

  it("⭐ id opaco (@lid) sem telefone não vira linha, mas é CONTADO — para dizer quantos ficaram de fora", () => {
    const r = consolidarAgenda(
      [{ id: "9999999999@lid", name: "Sem número" }],
      [{ id: "9999999999@lid" }, { id: "8888888888@lid" }],
    );
    expect(r.linhas).toEqual([]);
    expect(r.sem_telefone).toBe(2);
  });

  it("tira o sufixo de aparelho do número", () => {
    const r = consolidarAgenda([{ id: "5581999990010:12@s.whatsapp.net", name: "Multi" }], []);
    expect(r.linhas[0]?.telefone).toBe("+5581999990010");
  });

  it("número curto demais não é telefone", () => {
    const r = consolidarAgenda([{ id: "1234@c.us", name: "Curto" }], []);
    expect(r.linhas).toEqual([]);
  });

  it("ordena por nome, sem acento nem caixa, e deixa quem não tem nome por último", () => {
    const r = consolidarAgenda(
      [
        { id: "5581999990011@c.us", name: "zélia", isMyContact: true },
        { id: "5581999990012@c.us", name: "Álvaro", isMyContact: true },
        { id: "5581999990013@c.us", isMyContact: false },
      ],
      [],
    );
    expect(r.linhas.map((l) => l.nome)).toEqual(["Álvaro", "zélia", null]);
  });
});

function paginasDe(todos: Array<{ id: string }>, tamanho = 1000) {
  return vi.fn(async (_sessao: string, { offset }: { limit: number; offset: number }) =>
    todos.slice(offset, offset + tamanho),
  );
}

const contatos = (n: number, inicio = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `55819${String(inicio + i).padStart(8, "0")}@c.us`,
    name: `Pessoa ${inicio + i}`,
    isMyContact: true,
  }));

describe("carregarAgendaDaSessao", () => {
  it("⭐ lê TODAS as páginas — a lista de 2.500 não pode parar nos primeiros 1000", async () => {
    const listContacts = paginasDe(contatos(2500));
    const listChatsOverview = paginasDe([]);
    const r = await carregarAgendaDaSessao({ listContacts, listChatsOverview }, "s1");
    expect(r.linhas).toHaveLength(2500);
    expect(listContacts).toHaveBeenCalledTimes(3);
  });

  it("para quando o WAHA ignora o offset e devolve a mesma página — não entra em laço", async () => {
    const mesma = contatos(1000);
    const listContacts = vi.fn(async () => mesma);
    const r = await carregarAgendaDaSessao(
      { listContacts, listChatsOverview: paginasDe([]) },
      "s1",
    );
    expect(r.linhas).toHaveLength(1000);
    expect(listContacts).toHaveBeenCalledTimes(2);
  });

  it("junta contatos e conversas", async () => {
    const r = await carregarAgendaDaSessao(
      {
        listContacts: paginasDe(contatos(2)),
        listChatsOverview: paginasDe([{ id: "5581888880000@c.us" }]),
      },
      "s1",
    );
    expect(r.linhas).toHaveLength(3);
    expect(r.linhas.filter((l) => !l.salvo)).toHaveLength(1);
  });

  it("⭐ sessão sem armazenamento vira erro NEUTRO — quem chama não conhece o provedor", async () => {
    const listContacts = vi.fn(async () => {
      throw new WahaStoreDesligadoError();
    });
    await expect(
      carregarAgendaDaSessao({ listContacts, listChatsOverview: paginasDe([]) }, "s1"),
    ).rejects.toBeInstanceOf(AgendaIndisponivelError);
  });

  it("outro erro sobe como está (não é 'armazenamento desligado')", async () => {
    const listContacts = vi.fn(async () => {
      throw new Error("waha_502");
    });
    await expect(
      carregarAgendaDaSessao({ listContacts, listChatsOverview: paginasDe([]) }, "s1"),
    ).rejects.toThrow("waha_502");
  });

  it("acima do teto recusa em vez de montar um CSV gigante", async () => {
    const listContacts = vi.fn(async (_sessao: string, { offset }: { limit: number; offset: number }) =>
      contatos(1000, offset),
    );
    await expect(
      carregarAgendaDaSessao({ listContacts, listChatsOverview: paginasDe([]) }, "s1"),
    ).rejects.toBeInstanceOf(AgendaGrandeDemaisError);
  });
});
