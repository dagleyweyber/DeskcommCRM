/**
 * POST /api/v1/conversations/[id]/read — zera as não lidas da conversa.
 *
 * Por que existe: `unread_count_for_assignee` só subia (a cada mensagem do
 * cliente) e só zerava quando a conversa trocava de dono. Abrir a conversa não
 * mudava nada, então o "não lida" não dizia o que ninguém viu — na B'Laser
 * Parnamirim, 324 de 770 conversas abertas apareciam como não lidas
 * (2026-11-08). A leitura é da EQUIPE, não de quem abriu (decisão do dono do
 * produto, igual ao WhatsApp Web num número compartilhado): se alguém abriu,
 * sai das não lidas de todo mundo.
 *
 * Sem audit de propósito: abrir conversa é leitura, acontece a cada clique, e
 * entupiria o `api_audit_log` sem responder pergunta nenhuma de auditoria.
 * `.gt(0)` faz a chamada repetida não escrever nada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  // Cliente da sessão: a RLS decide se este atendente enxerga a conversa.
  const supabase = await createClient();
  const { error } = await supabase
    .from("conversations")
    .update({ unread_count_for_assignee: 0 })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .gt("unread_count_for_assignee", 0);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return noContent(requestId);
}
