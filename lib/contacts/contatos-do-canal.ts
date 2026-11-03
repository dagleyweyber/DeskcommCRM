/**
 * Quem são os contatos de UMA conexão de WhatsApp: os que têm conversa nela.
 *
 * O vínculo contato↔canal é a conversa (`conversations.channel_session_id`,
 * única por contato+canal). Isso inclui o histórico importado da coexistência,
 * e NÃO inclui a agenda do celular — `ingestContactSync` só enriquece o nome de
 * quem já é contato, por decisão (a agenda pessoal do dono não entra em lista de
 * campanha).
 *
 * Recebe o cliente do USUÁRIO (RLS vale), nunca o admin: a exportação não pode
 * enxergar mais do que a pessoa que clicou enxerga na tela.
 *
 * Pagina por `range`: o PostgREST corta em `max_rows` (1000) SEM erro, e um CSV
 * "completo" com 1000 linhas é o pior tipo de defeito — parece certo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ContatoExportavel, LinhaDoCanal } from "./exportacao";

/** Tamanho da página — não pode passar do `max_rows` do PostgREST. */
export const PAGINA = 1000;
/** Teto de segurança: acima disso a rota devolve erro em vez de montar CSV gigante em memória. */
export const LIMITE_DE_CONTATOS = 200_000;

const COLUNAS_DO_CONTATO =
  "name, display_name, phone_number, email, tags, source, is_blocked, consent, created_at";

interface LinhaDoBanco {
  created_at: string | null;
  last_message_at: string | null;
  // O PostgREST devolve objeto num embed to-one, mas o tipo gerado pode dizer array.
  contacts: ContatoExportavel | ContatoExportavel[] | null;
}

export class LimiteDeExportacaoError extends Error {
  constructor() {
    super(`Mais de ${LIMITE_DE_CONTATOS} contatos neste canal.`);
    this.name = "LimiteDeExportacaoError";
  }
}

export async function contatosDoCanal(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string,
): Promise<LinhaDoCanal[]> {
  const linhas: LinhaDoCanal[] = [];

  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await supabase
      .from("conversations")
      .select(`created_at, last_message_at, contacts!inner(${COLUNAS_DO_CONTATO})`)
      .eq("organization_id", orgId)
      .eq("channel_session_id", sessionId)
      .eq("is_group", false)
      .eq("contacts.is_anonymized", false)
      // `id` e não `created_at`: ordem total e estável entre páginas (sem empate).
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);

    const pagina = (data ?? []) as unknown as LinhaDoBanco[];
    for (const r of pagina) {
      const contato = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts;
      if (!contato) continue;
      linhas.push({
        contato,
        primeira_conversa_em: r.created_at,
        ultima_mensagem_em: r.last_message_at,
      });
    }
    if (linhas.length > LIMITE_DE_CONTATOS) throw new LimiteDeExportacaoError();
    if (pagina.length < PAGINA) return linhas;
  }
}
