/**
 * Nome do paciente vindo do Belle → contato que já existia no CRM sem nome.
 *
 * A sincronização acha o contato pelo celular. Se ele nasceu de uma conversa de
 * WhatsApp que não trouxe o nome, o contato fica com `display_name` vazio para
 * sempre — o Belle sabia o nome e a recepção via "+5581…" no lugar dele (medido em
 * 2026-10-30: 570 de 1.562 contatos com agendamento do Belle estavam sem nome).
 *
 * Regras, todas no sentido de NÃO estragar dado de quem já preencheu:
 *   - só preenche o que está vazio; nome existente (do CRM ou digitado por alguém)
 *     nunca é sobrescrito;
 *   - contato anonimizado (LGPD) nunca volta a ter nome;
 *   - `name` só é refeito se estiver vazio ou for o próprio telefone (o valor que o
 *     CRM grava quando não sabe o nome).
 */
export interface ContatoParaNome {
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  is_anonymized: boolean | null;
}

export interface NomeAPreencher {
  id: string;
  display_name: string;
  /** Presente só quando `name` também estava vazio ou era o telefone. */
  name?: string;
}

const vazio = (v: string | null | undefined) => !v || v.trim() === "";

/** `pares`: contato → nome que o Belle deu para ele (um contato pode aparecer várias vezes). */
export function nomesParaPreencher(
  contatos: Map<string, ContatoParaNome>,
  pares: Iterable<readonly [string, string]>,
): NomeAPreencher[] {
  const feitos = new Set<string>();
  const saida: NomeAPreencher[] = [];
  for (const [id, nomeBruto] of pares) {
    if (feitos.has(id)) continue;
    const nome = nomeBruto.trim();
    const c = contatos.get(id);
    if (!c || !nome || c.is_anonymized || !vazio(c.display_name)) continue;
    feitos.add(id);
    const refazName = vazio(c.name) || c.name?.trim() === c.phone_number?.trim();
    saida.push(refazName ? { id, display_name: nome, name: nome } : { id, display_name: nome });
  }
  return saida;
}
