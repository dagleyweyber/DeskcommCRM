import { describe, expect, it } from "vitest";

import type { ContatoDaAgenda } from "@/lib/channels/agenda";

import {
  celulaCsv,
  CABECALHO_AGENDA,
  CABECALHO_EXPORTACAO,
  consentimentoDeMarketing,
  montarCsv,
  montarCsvAgenda,
  nomeDoArquivo,
  type LinhaDoCanal,
} from "./exportacao";

const linha = (over: Partial<LinhaDoCanal["contato"]> = {}): LinhaDoCanal => ({
  contato: {
    name: "João Silva",
    display_name: null,
    phone_number: "+5581999990000",
    email: null,
    tags: ["clientes", "vip"],
    source: "whatsapp",
    is_blocked: false,
    consent: {},
    created_at: "2026-11-01T10:00:00Z",
    ...over,
  },
  primeira_conversa_em: "2026-11-01T10:00:00Z",
  ultima_mensagem_em: "2026-11-02T10:00:00Z",
});

describe("celulaCsv", () => {
  it("escapa vírgula, aspas e quebra de linha", () => {
    expect(celulaCsv('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("⭐ neutraliza fórmula: nome vem de quem escreveu no WhatsApp", () => {
    for (const perigoso of ["=HYPERLINK(\"http://x\")", "+1+1", "-2", "@SUM(A1)"]) {
      expect(celulaCsv(perigoso).replace(/^"/, "")).toMatch(/^'/);
    }
  });

  it("⭐ telefone com + NÃO é tratado como fórmula (senão todo telefone sai corrompido)", () => {
    expect(celulaCsv("+5581999990000")).toBe("+5581999990000");
  });

  it("nulo e indefinido viram célula vazia", () => {
    expect(celulaCsv(null)).toBe("");
    expect(celulaCsv(undefined)).toBe("");
  });
});

describe("consentimentoDeMarketing", () => {
  it("⭐ revogado ganha de concedido", () => {
    expect(consentimentoDeMarketing({ marketing: { granted_at: "a", revoked_at: "b" } })).toBe("revogado");
  });
  it("concedido, e sem registro é nao_informado (não 'nao')", () => {
    expect(consentimentoDeMarketing({ marketing: { granted_at: "a" } })).toBe("concedido");
    expect(consentimentoDeMarketing({})).toBe("nao_informado");
    expect(consentimentoDeMarketing(null)).toBe("nao_informado");
  });
});

describe("montarCsv", () => {
  it("começa com BOM UTF-8 e o cabeçalho, e termina com quebra de linha", () => {
    const csv = montarCsv([linha()]);
    expect(csv.startsWith("﻿" + CABECALHO_EXPORTACAO.join(","))).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("cada contato vira uma linha com tags separadas por | e bloqueio legível", () => {
    const [, dados] = montarCsv([linha({ is_blocked: true })]).split("\r\n");
    expect(dados).toBe(
      "João Silva,+5581999990000,,clientes|vip,whatsapp,2026-11-01T10:00:00Z,2026-11-02T10:00:00Z,sim,nao_informado",
    );
  });

  it("sem nome usa o nome de exibição", () => {
    const [, dados] = montarCsv([linha({ name: null, display_name: "Maria" })]).split("\r\n");
    expect(dados!.startsWith("Maria,")).toBe(true);
  });

  it("canal sem contatos gera só o cabeçalho", () => {
    expect(montarCsv([]).split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("nomeDoArquivo", () => {
  it("sem acento, em minúsculas e com a data", () => {
    expect(nomeDoArquivo("B'Laser Parnamirim", new Date("2026-11-03T12:00:00Z"))).toBe(
      "contatos-b-laser-parnamirim-2026-11-03.csv",
    );
  });
  it("rótulo vazio cai em 'canal'", () => {
    expect(nomeDoArquivo("***", new Date("2026-11-03T12:00:00Z"))).toBe("contatos-canal-2026-11-03.csv");
  });
});

describe("montarCsvAgenda", () => {
  const pessoa = (over: Partial<ContatoDaAgenda> = {}): ContatoDaAgenda => ({
    nome: "Maria Silva",
    telefone: "+5581999990001",
    salvo: true,
    nome_no_whatsapp: "Mari",
    ...over,
  });

  it("cabeçalho próprio, BOM e uma linha por pessoa com salvo legível", () => {
    const csv = montarCsvAgenda([pessoa(), pessoa({ nome: null, telefone: "+5581999990002", salvo: false, nome_no_whatsapp: null })]);
    expect(csv.startsWith("﻿" + CABECALHO_AGENDA.join(","))).toBe(true);
    const [, a, b] = csv.split("\r\n");
    expect(a).toBe("Maria Silva,+5581999990001,sim,Mari");
    expect(b).toBe(",+5581999990002,nao,");
  });

  it("⭐ nome vindo do WhatsApp com fórmula é neutralizado; o telefone continua intacto", () => {
    const [, linha] = montarCsvAgenda([pessoa({ nome: '=HYPERLINK("http://x")', nome_no_whatsapp: "+1+1" })]).split("\r\n");
    expect(linha).toContain("'=HYPERLINK");
    expect(linha).toContain(",+5581999990001,");
    expect(linha).toContain("'+1+1");
  });

  it("lista vazia gera só o cabeçalho", () => {
    expect(montarCsvAgenda([]).split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("nomeDoArquivo com prefixo", () => {
  it("a agenda sai com outro prefixo para não confundir com a de conversas", () => {
    expect(nomeDoArquivo("Ads Company", new Date("2026-11-05T12:00:00Z"), "agenda")).toBe(
      "agenda-ads-company-2026-11-05.csv",
    );
  });
});
