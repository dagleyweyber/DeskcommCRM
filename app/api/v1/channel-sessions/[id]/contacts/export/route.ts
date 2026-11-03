/**
 * GET /api/v1/channel-sessions/[id]/contacts/export — CSV dos contatos de UMA
 * conexão de WhatsApp (os que têm conversa nela).
 *
 * Thin wrapper: papel + canal da organização + CSV + auditoria. A busca mora em
 * `lib/contacts/contatos-do-canal.ts` e o formato em `lib/contacts/exportacao.ts`.
 *
 * `manager`+: é dado pessoal saindo do CRM em massa (LGPD) — mesmo piso da
 * importação. Cada download vira `contacts.exported` na auditoria, com quem
 * baixou e quantos contatos.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { contatosDoCanal, LimiteDeExportacaoError } from "@/lib/contacts/contatos-do-canal";
import { montarCsv, nomeDoArquivo } from "@/lib/contacts/exportacao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const supabase = await createClient();
  const { data: canal } = await supabase
    .from("channel_sessions")
    .select("id, display_name, phone_number")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id.data)
    .maybeSingle();
  if (!canal) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  let linhas;
  try {
    linhas = await contatosDoCanal(supabase, authz.org.orgId, canal.id);
  } catch (err) {
    if (err instanceof LimiteDeExportacaoError) {
      return fail("payload_too_large", err.message, 413, { requestId });
    }
    return fail("internal_error", err instanceof Error ? err.message : "export_failed", 500, {
      requestId,
    });
  }

  await audit({
    action: "contacts.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: canal.id,
    requestId,
    metadata: { actor_type: "user", contatos: linhas.length },
  });

  const arquivo = nomeDoArquivo(canal.display_name ?? canal.phone_number ?? "canal", new Date());
  return new Response(montarCsv(linhas), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${arquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
