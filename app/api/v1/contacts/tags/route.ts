/**
 * GET /api/v1/contacts/tags — todas as tags dos contatos da organização ativa,
 * com quantos contatos têm cada uma (`fn_tags_dos_contatos`, migration 0210).
 *
 * Alimenta o filtro de Contatos, a sugestão de tags na importação e a escolha
 * de público da campanha — antes cada um montava a lista do que tinha na tela,
 * e tag de base importada não aparecia em lugar nenhum.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import type { TagDosContatos } from "@/lib/types/contacts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_tags_dos_contatos", { p_org: authz.org.orgId });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const tags: TagDosContatos[] = ((data ?? []) as Array<{ tag: string; total: number | string }>).map((t) => ({
    tag: t.tag,
    total: Number(t.total),
  }));
  return ok(tags, { requestId });
}
