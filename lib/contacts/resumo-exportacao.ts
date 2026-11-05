/**
 * O que dizer a quem acabou de baixar a agenda de um número.
 *
 * Existe porque o arquivo NÃO é "todo mundo", e quem o recebe vai supor que é: o
 * WhatsApp esconde o telefone de quem não está na agenda e só o identifica por um
 * código interno (quem te escreveu sem ser contato, participantes de grupo).
 * Nem o próprio WhatsApp tem o número dessas pessoas, então elas não saem — e
 * sem esta frase a planilha parece incompleta por defeito do CRM.
 *
 * Pura, para o texto ser testável sem tela.
 */

const nf = new Intl.NumberFormat("pt-BR");

export interface FraseDaExportacao {
  titulo: string;
  detalhe: string | null;
}

/**
 * `exportados` é `null` quando a fonte não informa (a exportação de conversas):
 * aí não há o que dizer além do download, que o navegador já mostra.
 */
export function fraseDaExportacao(
  exportados: number | null,
  semNumero: number,
): FraseDaExportacao | null {
  if (exportados === null || !Number.isFinite(exportados)) return null;
  const titulo = `${nf.format(exportados)} ${exportados === 1 ? "contato exportado" : "contatos exportados"}.`;
  if (!Number.isFinite(semNumero) || semNumero <= 0) return { titulo, detalhe: null };
  return {
    titulo,
    detalhe:
      `Outras ${nf.format(semNumero)} ${semNumero === 1 ? "pessoa ficou" : "pessoas ficaram"} de fora: ` +
      "o WhatsApp só as identifica por um código interno, sem o telefone — em geral quem te escreveu " +
      "sem estar na agenda ou participantes de grupo. Nem o WhatsApp tem esse número, então não dá para exportar.",
  };
}
