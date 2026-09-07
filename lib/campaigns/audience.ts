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

async function porTag(
  admin: SupabaseClient,
  organizationId: string,
  tag: string,
): Promise<AudienceMember[]> {
  const { data } = await admin
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("organization_id", organizationId)
    .eq("is_blocked", false)
    .contains("tags", [tag]);

  return ((data ?? []) as ContatoBruto[]).filter(comTelefone).map((c) => ({
    contactId: c.id,
    leadId: null,
    displayName: rotuloDoContato(c),
  }));
}

async function todosOsContatos(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AudienceMember[]> {
  const { data } = await admin
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("organization_id", organizationId)
    .eq("is_blocked", false);

  return ((data ?? []) as ContatoBruto[]).filter(comTelefone).map((c) => ({
    contactId: c.id,
    leadId: null,
    displayName: rotuloDoContato(c),
  }));
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

  const linhas = (leads ?? []) as Array<{ id: string; contact_id: string }>;
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
