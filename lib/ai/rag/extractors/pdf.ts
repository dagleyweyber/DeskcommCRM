/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * ─── Por que pdftotext primeiro, e não pdf-parse ────────────────────────────
 *
 * `extractPdfText` roda dentro do `media_derive` handler, que o cron
 * `event-log-drain` executa NO PROCESSO DO APP — o mesmo servidor Next.js que
 * atende o CRM inteiro (ver Dockerfile, comentário do `apk add`), não um
 * worker isolado. `pdf-parse`/`pdfjs-dist` extraem IN-PROCESS: um PDF
 * adversário (mesmo pequeno — o fornecedor mediu "poucos KB") pode estourar
 * memória ali e derrubar o processo inteiro, para TODAS as organizações, não
 * só a que mandou o arquivo.
 *
 * `pdftotext` (poppler-utils) roda como processo à parte via `spawn` — mesmo
 * padrão já usado pra ffmpeg em `lib/messaging/media/voice-transcode.ts`. Se
 * ele travar ou estourar memória, só ele morre; o app continua de pé. Por
 * isso é o caminho PRIMÁRIO, e os dois extratores antigos viram reserva —
 * usados só se o binário faltar ou falhar, e só até um teto de tamanho (ver
 * `IN_PROCESS_MAX_BYTES`): acima dele, sem pdftotext, falha explícita é
 * melhor que arriscar o processo compartilhado.
 *
 * Primary: pdftotext (processo isolado via spawn).
 * Fallback 1 (só até IN_PROCESS_MAX_BYTES): pdf-parse.
 * Fallback 2 (idem): pdfjs-dist legacy build.
 * Todos falham → throws PdfExtractError.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as PdfjsDist from "pdfjs-dist";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/**
 * Teto pro caminho de RESERVA (in-process). pdftotext não tem este teto —
 * roda isolado, então um arquivo grande nele só custa tempo, não risco pro
 * app. Sem o binário (ou se ele falhar), um PDF maior que isto prefere um
 * erro claro a arriscar estourar memória no processo que atende todo mundo.
 */
const IN_PROCESS_MAX_BYTES = 8 * 1024 * 1024; // 8MB

/** Teto de tempo pro processo isolado — trava por conteúdo adversário não pode segurar o drain pra sempre. */
const PDFTOTEXT_TIMEOUT_MS = 30_000;

/** Roda `pdftotext -layout <arquivo> -`; rejeita se sair diferente de zero, faltar o binário, ou estourar o tempo. */
async function runPdftotext(buffer: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-"));
  try {
    const entrada = join(dir, "in.pdf");
    await writeFile(entrada, buffer);

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn("pdftotext", ["-layout", entrada, "-"]);
      let out = "";
      let erro = "";
      let liquidado = false;

      const timer = setTimeout(() => {
        liquidado = true;
        proc.kill("SIGKILL");
        reject(new Error("pdftotext_timeout"));
      }, PDFTOTEXT_TIMEOUT_MS);

      proc.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      proc.stderr?.on("data", (d: Buffer) => {
        // Só o fim interessa: pdftotext pode escrever avisos longos, o erro real vem por último.
        erro = (erro + d.toString()).slice(-500);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!liquidado) reject(new Error(`pdftotext_spawn_failed: ${err.message}`));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (liquidado) return;
        if (code === 0) resolve(out.trim());
        else reject(new Error(`pdftotext_exit_${code}: ${erro}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ExtractPdfTextDeps {
  /** Injetável para teste — nunca bater num binário real fora do runtime de produção. */
  runPdftotext?: typeof runPdftotext;
}

/**
 * Extracts plain text from a PDF buffer.
 * Tries pdftotext first (isolated process); falls back to pdf-parse, then
 * pdfjs-dist (both in-process, capped at IN_PROCESS_MAX_BYTES).
 * Throws `PdfExtractError` if every strategy fails.
 */
export async function extractPdfText(buffer: Buffer, deps: ExtractPdfTextDeps = {}): Promise<string> {
  const executarPdftotext = deps.runPdftotext ?? runPdftotext;

  // --- Primary: pdftotext, processo isolado ---
  try {
    const texto = await executarPdftotext(buffer);
    if (texto.length > 0) return texto;
    console.warn("[pdf-extract] pdftotext devolveu vazio — pode ser PDF só-imagem; tentando reserva in-process");
  } catch (err) {
    console.warn("[pdf-extract] pdftotext indisponível ou falhou, tentando reserva in-process:", err);
  }

  // Daqui em diante, tudo roda NO MESMO PROCESSO do app (ver cabeçalho do
  // arquivo). Sem pdftotext, um PDF grande é risco real, não só lentidão.
  if (buffer.byteLength > IN_PROCESS_MAX_BYTES) {
    throw new PdfExtractError(
      `PDF de ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB é grande demais pra extrair sem pdftotext ` +
        `(limite de ${IN_PROCESS_MAX_BYTES / 1024 / 1024}MB no caminho de reserva, que roda no processo do app).`,
    );
  }

  // --- Fallback 1: pdf-parse (fast, handles most PDFs) ---
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    if (text.length > 0) return text;
    // Empty text from pdf-parse — may be an image-only PDF; fall through to pdfjs
    console.warn("[pdf-extract] pdf-parse returned empty text — trying pdfjs fallback");
  } catch (err) {
    console.warn("[pdf-extract] pdf-parse failed, trying pdfjs-dist fallback:", err);
  }

  // --- Fallback 2: pdfjs-dist legacy build ---
  try {
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof PdfjsDist;

    // NÃO mexa em GlobalWorkerOptions.workerSrc aqui (issue #102).
    //
    // Havia um `workerSrc = ""` nesta linha, com a intenção de "desligar o worker
    // em Node". O efeito era o oposto: string vazia é falsy, e o getter
    // `PDFWorker.workerSrc` lança `No "GlobalWorkerOptions.workerSrc" specified.`
    // ANTES de ler um byte do arquivo — ou seja, o fallback inteiro era inalcançável,
    // e o erro chegava ao usuário como a mensagem genérica lá de baixo.
    //
    // Em Node o pdf.js já se auto-configura; as três linhas sobrescreviam justamente
    // o que a lib tinha preparado. Medido nas versões 4.10.38 e 6.2.108: com
    // `workerSrc = ""` falha nas duas; sem tocar, extrai nas duas.
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdfDocument = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      if (pageText.length > 0) pageTexts.push(pageText);
    }

    const combined = pageTexts.join("\n\n").trim();
    if (combined.length === 0) {
      throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)");
    }
    return combined;
  } catch (err) {
    if (err instanceof PdfExtractError) throw err;

    // O pdfjs 6 faz `new DOMMatrix()` no topo do módulo e depende do
    // `@napi-rs/canvas` (optionalDependency) para o polyfill. Sem esse binário —
    // plataforma sem binding publicado, registry corporativo sem os artefatos, ou
    // instalação com optional deps podadas — ele estoura no IMPORT, antes de ler o
    // arquivo. A versão 4 só avisava e extraía o texto assim mesmo.
    //
    // Sem esta mensagem, quem instalou vê "DOMMatrix is not defined" e não tem como
    // ligar isso a uma dependência que ele nem sabe que existe. O diagnóstico custa
    // 4 linhas; a caçada custa uma tarde.
    if (err instanceof Error && /DOMMatrix|@napi-rs\/canvas/.test(err.message)) {
      throw new PdfExtractError(
        "Extração de PDF indisponível: o binário nativo @napi-rs/canvas não foi instalado " +
          "nesta plataforma. Reinstale as dependências SEM podar as opcionais " +
          "(`pnpm install`, não `--no-optional`). Até lá, PDFs não são lidos.",
        err,
      );
    }

    throw new PdfExtractError("Both pdf-parse and pdfjs-dist failed to extract text", err);
  }
}
