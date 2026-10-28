/**
 * GET /api/v1/rastreio/cliques/resumo — cliques no botão do WhatsApp das landing pages nos
 * últimos 30 dias e quantos viraram conversa ligada à origem do anúncio.
 *
 * Existe porque o rastreio do botão é melhor-esforço (a pessoa pode apagar o `ref:` da
 * mensagem): a taxa de ligação é o que diz se ele funciona. Ver `lib/atribuicao/resumo-de-cliques.ts`.
 * Lê pela RLS do caller (`tenant_isolation_rastreio_cliques_select`).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { resumeCliques } from "@/lib/atribuicao/resumo-de-cliques";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DIAS = 30;

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "rastreio_cliques" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createClient();
  const base = () =>
    supabase
      .from("rastreio_cliques")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrg.orgId)
      .gte("created_at", desde);

  const [total, ligados] = await Promise.all([base(), base().not("usado_em", "is", null)]);
  if (total.error || ligados.error) {
    return fail("internal_error", "Erro ao ler os cliques do WhatsApp.", 500, { requestId });
  }

  return ok(resumeCliques(total.count ?? 0, ligados.count ?? 0, DIAS), { requestId });
}
