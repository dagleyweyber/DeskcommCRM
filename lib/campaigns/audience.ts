/**
 * Resolve o PÚBLICO de uma campanha — chamada uma vez, na criação. O
 * resultado é materializado em `whatsapp_campaign_recipients`; esta função
 * nunca é chamada de novo pro despachante decidir quem já devia ter saído
 * ou entrado (ver o cabeçalho da migration 0167 pra por quê).
 *
 * `is_blocked = true` é excluído em QUALQUER filtro, sem exceção — mesma
 * regra que `nascimento-do-lead.ts` já aplica pra quem mandou STOP: pediu
 * pra sair não vira destinatário de nada.
 *
 * Duas consultas em vez de um JOIN embutido (`crm_leads.select("...,
 * contacts!inner(...)")`) de propósito: o filtro por etapa busca os leads
 * primeiro, depois os contatos por id — mais simples de ler, e o mesmo
 * resultado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

export type AudienceFilter =
  | { kind: "tag"; tag: string }
  | { kind: "pipeline_stage"; pipelineId: string; stageId: string }
  | { kind: "all_contacts" };

export interface AudienceMember {
  contactId: string;
  leadId: string | null;
  /** Já passado por `rotuloDoContato` — nunca um identificador técnico. */
  displayName: string;
}

interface ContatoBruto {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
}

/** Sem telefone não há como mandar WhatsApp — fora do público, sempre. */
function comTelefone(c: ContatoBruto): boolean {
  return Boolean(c.phone_number && c.phone_number.trim() !== "");
}

/**
 * Página do PostgREST. O servidor corta toda leitura em `max_rows` (1000, o
 * padrão do Supabase — `supabase/config.toml`) SEM erro: sem paginar, uma
 * campanha para uma base importada de 5.000 contatos saía para os 1.000
 * primeiros e o resto sumia em silêncio. Não doía antes só porque a maior
 * campanha até 2026-11-02 teve 39 destinatários.
 */
export const PAGINA_DO_PUBLICO = 1000;

/**
 * Lê TODOS os contatos que o filtro deixa passar, página a página, em ordem de
 * `id` (estável entre páginas). Contato fundido em outro (`is_merged_into`) fica
 * de fora: o sobrevivente da fusão já está no público, e o fundido manteria o
 * mesmo telefone — mesma pessoa recebendo duas vezes.
 */
async function contatosPaginados(
  admin: SupabaseClient,
  organizationId: string,
  tag: string | null,
): Promise<ContatoBruto[]> {
  const todos: ContatoBruto[] = [];
  for (let de = 0; ; de += PAGINA_DO_PUBLICO) {
    let q = admin
      .from("contacts")
      .select("id, display_name, name, phone_number")
      .eq("organization_id", organizationId)
      .eq("is_blocked", false)
      .is("is_merged_into", null);
    if (tag !== null) q = q.contains("tags", [tag]);
    const { data, error } = await q.order("id", { ascending: true }).range(de, de + PAGINA_DO_PUBLICO - 1);
    // Falha no meio não pode virar "público menor": quem cria a campanha precisa
    // saber, não disparar para metade da base achando que é tudo.
    if (error) throw new Error(`audience_read_failed: ${error.message}`);
    const pagina = (data ?? []) as ContatoBruto[];
    todos.push(...pagina);
    if (pagina.length < PAGINA_DO_PUBLICO) return todos;
  }
}

const paraMembro = (c: ContatoBruto): AudienceMember => ({
  contactId: c.id,
  leadId: null,
  displayName: rotuloDoContato(c),
});

async function porTag(
  admin: SupabaseClient,
  organizationId: string,
  tag: string,
): Promise<AudienceMember[]> {
  const contatos = await contatosPaginados(admin, organizationId, tag);
  return contatos.filter(comTelefone).map(paraMembro);
}

async function todosOsContatos(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AudienceMember[]> {
  const contatos = await contatosPaginados(admin, organizationId, null);
  return contatos.filter(comTelefone).map(paraMembro);
}

/**
 * `status = 'open'` — só quem ainda está DE VERDADE nesta etapa. Um lead que
 * fechou (won/lost/existing_customer) pode ter ficado com o `stage_id` da
 * última etapa visitada; incluir esses seria mandar campanha pra negócio
 * que já acabou.
 */
async function porEtapaDoFunil(
  admin: SupabaseClient,
  organizationId: string,
  pipelineId: string,
  stageId: string,
): Promise<AudienceMember[]> {
  const { data: leads } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("stage_id", stageId)
    .eq("status", "open");

  // `contact_id` É nullable — lead criado direto no Kanban (sem vir de uma
  // conversa) nasce sem contato vinculado, achado ao vivo nesta mesma sessão
  // pra RevitaFio Mossoró. Sem este filtro, um `null` entrava no array do
  // `.in("id", ...)` abaixo, o PostgREST devolvia `22P02 invalid input
  // syntax for type uuid: "null"`, e como o erro nunca era checado o
  // `contatos ?? []` mascarava a falha como "zero contato bate" — não só
  // pros leads órfãos, pra ETAPA INTEIRA, porque a query de contatos inteira
  // falhava.
  const linhas = ((leads ?? []) as Array<{ id: string; contact_id: string | null }>).filter(
    (l): l is { id: string; contact_id: string } => l.contact_id !== null,
  );
  if (linhas.length === 0) return [];

  const contactIds = [...new Set(linhas.map((l) => l.contact_id))];
  const { data: contatos } = await admin
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("organization_id", organizationId)
    .eq("is_blocked", false)
    .in("id", contactIds);

  const contatoPorId = new Map(
    ((contatos ?? []) as ContatoBruto[]).filter(comTelefone).map((c) => [c.id, c]),
  );

  // Um contato por vez no público, mesmo que tenha mais de um lead nesta
  // etapa (não deveria acontecer — "um lead por demanda" — mas o público
  // não pode duplicar destinatário se acontecer).
  const vistos = new Set<string>();
  const out: AudienceMember[] = [];
  for (const l of linhas) {
    const contato = contatoPorId.get(l.contact_id);
    if (!contato || vistos.has(l.contact_id)) continue;
    vistos.add(l.contact_id);
    out.push({ contactId: l.contact_id, leadId: l.id, displayName: rotuloDoContato(contato) });
  }
  return out;
}

export async function resolveAudience(
  admin: SupabaseClient,
  organizationId: string,
  filter: AudienceFilter,
): Promise<AudienceMember[]> {
  switch (filter.kind) {
    case "tag":
      return porTag(admin, organizationId, filter.tag);
    case "pipeline_stage":
      return porEtapaDoFunil(admin, organizationId, filter.pipelineId, filter.stageId);
    case "all_contacts":
      return todosOsContatos(admin, organizationId);
  }
}
