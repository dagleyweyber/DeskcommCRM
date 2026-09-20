// @vitest-environment node
//
// Issue #102. Este arquivo existe porque `extractPdfText` estava mockado em TODOS
// os testes que o tocavam (`extractPdf: vi.fn(...)` em media-derive.test.ts), então
// nenhuma linha de pdfjs era executada pelo CI. O fallback ficou quebrado por um
// `GlobalWorkerOptions.workerSrc = ""` e o CI seguiu verde o tempo todo.
//
// O segundo teste é o que trava a regressão: ele força a falha do pdf-parse para
// exercitar o caminho do pdfjs — o mesmo caminho que estava morto.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const FIXTURE = join(process.cwd(), "tests/fixtures/sample-text.pdf");
const TEXTO_ESPERADO = "DeskcommCRM RAG fixture";

/**
 * Todo teste aqui injeta `runPdftotext` — nunca deixa o poppler REAL decidir
 * o caminho. Sem isto, os testes ficariam dependentes de o binário estar
 * instalado (ou não) na máquina que roda `pnpm test:unit`: verde por sorte
 * de ambiente, não por contrato. A ausência do binário em produção já está
 * coberta por "poppler indisponível" abaixo — é o mesmo erro que `spawn`
 * devolve de verdade quando falta.
 */
const popplerIndisponivel = async (): Promise<never> => {
  throw new Error("pdftotext_spawn_failed: spawn pdftotext ENOENT");
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("pdf-parse");
});

describe("extractPdfText", () => {
  it("extrai texto de um PDF real (via pdf-parse, com poppler indisponível)", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    const texto = await extractPdfText(readFileSync(FIXTURE), { runPdftotext: popplerIndisponivel });
    expect(texto).toContain(TEXTO_ESPERADO);
  });

  it("⭐ usa o pdftotext quando disponível, sem tocar pdf-parse/pdfjs (processo isolado é o caminho primário)", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    const texto = await extractPdfText(readFileSync(FIXTURE), {
      runPdftotext: async () => "texto vindo do pdftotext isolado",
    });
    expect(texto).toBe("texto vindo do pdftotext isolado");
  });

  it("cai no fallback do pdfjs quando pdftotext falta E o pdf-parse falha, e ainda extrai", async () => {
    // Sabota o primário in-process. Se o fallback estiver quebrado, isto fica
    // vermelho — que é exatamente o que não acontecia antes desta correção.
    vi.doMock("pdf-parse", () => ({
      default: () => {
        throw new Error("pdf-parse sabotado de propósito");
      },
    }));
    vi.resetModules();

    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    const texto = await extractPdfText(readFileSync(FIXTURE), { runPdftotext: popplerIndisponivel });
    expect(texto).toContain(TEXTO_ESPERADO);
  });

  it("diz o que fazer quando o binário nativo do canvas falta", async () => {
    // O pdfjs 6 estoura no import sem @napi-rs/canvas. Sem esta tradução o
    // self-hoster vê "DOMMatrix is not defined" e não tem como ligar isso a uma
    // dependência opcional que ele nem sabe que existe.
    vi.doMock("pdf-parse", () => ({
      default: () => {
        throw new Error("pdf-parse sabotado de propósito");
      },
    }));
    // Na VPS o erro nasce no IMPORT do módulo. Aqui ele nasce no getDocument, e é
    // fiel ao que importa: o branch decide pela MENSAGEM, não pelo ponto de origem.
    // (Mockar o factory para lançar não serve — o vitest reembrulha e a mensagem some.)
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      GlobalWorkerOptions: {},
      getDocument: () => {
        throw new Error("DOMMatrix is not defined");
      },
    }));
    vi.resetModules();

    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(
      extractPdfText(readFileSync(FIXTURE), { runPdftotext: popplerIndisponivel }),
    ).rejects.toThrow(PdfExtractError);
    await expect(
      extractPdfText(readFileSync(FIXTURE), { runPdftotext: popplerIndisponivel }),
    ).rejects.toThrow(/@napi-rs\/canvas/);
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  });

  it("lança PdfExtractError quando o buffer não é PDF", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(
      extractPdfText(Buffer.from("isto não é um pdf"), { runPdftotext: popplerIndisponivel }),
    ).rejects.toBeInstanceOf(PdfExtractError);
  });

  it("⭐ sem pdftotext, recusa PDF grande em vez de arriscar o processo do app (não cai pro pdf-parse)", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    const grande = Buffer.alloc(9 * 1024 * 1024, 0x25); // 9MB > teto de 8MB do caminho de reserva
    await expect(
      extractPdfText(grande, { runPdftotext: popplerIndisponivel }),
    ).rejects.toThrow(PdfExtractError);
    await expect(
      extractPdfText(grande, { runPdftotext: popplerIndisponivel }),
    ).rejects.toThrow(/grande demais/);
  });
});
