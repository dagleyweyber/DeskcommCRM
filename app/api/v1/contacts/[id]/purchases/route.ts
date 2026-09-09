/**
 * GET /api/v1/contacts/[id]/purchases — histórico de compras do contato, pra
 * "Visão geral" no perfil (`app/app/contacts/[id]/_client.tsx`).
 *
 * Pedido explícito do dono da agência: um cliente que compra 2, 3, 4+ vezes
 * precisa ver esse histórico resumido num lugar só — data, valor, produto —
 * sem abrir a timeline inteira e separar compra de mensagem no meio.
 *
 * `won` é a mesma leitura que já alimenta `/api/v1/customers` e o dashboard
 * de vendas (`fn_sales_dashboard`'s CTE `clientes`) — nenhuma fonte nova.
 * `custom_fields->>'produto_interesse'` é o mesmo campo que o dashboard já lê
 * como "serviço" (ver `receita_por_origem`); "Não informado" é o MESMO
 * fallback de lá, pra não inventar um rótulo novo pro mesmo vazio.
 *
 * Client de SESSÃO (não admin): RLS (`fn_can_view_lead`) já escopa por
 * organização — mesmo padrão de `crm-summary/route.ts`, que existe
 * justamente porque o cliente do browser não carrega a sessão (cookie
 * httpOnly) e vira `anon`. Rodando no servidor, a sessão existe.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface Purchase {
  id: string;
  title: string;
  closed_at: string | null;
  value_cents: number | null;
  currency: string | null;
  produto: string | null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data, error } = await supabase
    .from("crm_leads")
    .select("id, title, closed_at, value_cents, currency, custom_fields")
    .eq("contact_id", contactId)
    .eq("status", "won")
    .order("closed_at", { ascending: false });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const purchases: Purchase[] = (data ?? []).map((l) => {
    const custom = l.custom_fields as Record<string, unknown> | null;
    const produto = typeof custom?.produto_interesse === "string" ? custom.produto_interesse : null;
    return {
      id: l.id as string,
      title: l.title as string,
      closed_at: l.closed_at as string | null,
      value_cents: l.value_cents as number | null,
      currency: l.currency as string | null,
      produto,
    };
  });

  return ok({ purchases }, { requestId });
}
