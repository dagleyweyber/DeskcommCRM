/**
 * Arquivo do operador → cabeçalho + linhas de texto. Só navegador: o arquivo
 * nunca sobe para o servidor (vão as linhas, em lotes — ver a rota de import).
 *
 * As duas armadilhas de planilha brasileira que isto resolve:
 *   - CSV salvo pelo Excel em pt-BR vem em Windows-1252 e separado por `;`.
 *     Lido como UTF-8, "João" vira "Jo�o". Tenta UTF-8 estrito; falhando, 1252.
 *   - Telefone em célula numérica do .xlsx: lido como número, 5581991840070
 *     passa por ponto flutuante. `parseNumber` devolve o texto cru da célula.
 */
import Papa from "papaparse";
import { readSheet } from "read-excel-file/browser";

import { MAX_LINHAS_POR_ARQUIVO } from "@/lib/contacts/importacao";

export interface Planilha {
  cabecalho: string[];
  linhas: string[][];
}

export class ErroDePlanilha extends Error {}

const EXTENSOES_CSV = [".csv", ".txt"];
const EXTENSOES_EXCEL = [".xlsx"];

export const ACEITA = [...EXTENSOES_CSV, ...EXTENSOES_EXCEL].join(",");

function decodificar(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

const texto = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();

function montar(matriz: unknown[][]): Planilha {
  const [cab, ...resto] = matriz.filter((l) => l.some((v) => texto(v) !== ""));
  if (!cab) throw new ErroDePlanilha("A planilha está vazia.");
  if (resto.length === 0) throw new ErroDePlanilha("A planilha só tem o cabeçalho — nenhuma linha de contato.");
  if (resto.length > MAX_LINHAS_POR_ARQUIVO) {
    throw new ErroDePlanilha(
      `A planilha tem ${resto.length.toLocaleString("pt-BR")} linhas; o máximo por arquivo é ` +
        `${MAX_LINHAS_POR_ARQUIVO.toLocaleString("pt-BR")}. Divida em arquivos menores.`,
    );
  }
  const cabecalho = cab.map((v, i) => texto(v) || `Coluna ${i + 1}`);
  return { cabecalho, linhas: resto.map((l) => cabecalho.map((_, i) => texto(l[i]))) };
}

export async function lerPlanilha(arquivo: File): Promise<Planilha> {
  const nome = arquivo.name.toLowerCase();
  if (nome.endsWith(".xls")) {
    throw new ErroDePlanilha("Arquivo .xls (Excel 97) não é suportado. No Excel, use Salvar como → .xlsx ou .csv.");
  }

  if (EXTENSOES_EXCEL.some((e) => nome.endsWith(e))) {
    try {
      const dados = await readSheet<string>(arquivo, { parseNumber: (s) => s });
      return montar(dados as unknown[][]);
    } catch (err) {
      if (err instanceof ErroDePlanilha) throw err;
      throw new ErroDePlanilha("Não consegui ler este .xlsx. Confira se o arquivo abre no Excel.");
    }
  }

  if (EXTENSOES_CSV.some((e) => nome.endsWith(e))) {
    const conteudo = decodificar(await arquivo.arrayBuffer()).replace(/^﻿/, "");
    const r = Papa.parse<string[]>(conteudo, { skipEmptyLines: "greedy" });
    if (r.data.length === 0) throw new ErroDePlanilha("A planilha está vazia.");
    return montar(r.data);
  }

  throw new ErroDePlanilha("Formato não suportado. Envie .csv ou .xlsx.");
}
