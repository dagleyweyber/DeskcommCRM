/**
 * GET /api/v1/customers
 *
 * "Cliente" = contato com `became_customer_at` preenchido (migration 0164) —
 * ou já comprou pelo menos uma vez (`won`, marcado automático no
 * `lead.won`), ou foi reconhecido manualmente ("Marcar como cliente já
 * existente"). Não é filtro novo: é o MESMO campo das Fases 2/3.
 *
 * LTV/quantidade de compras vêm de `crm_leads` (`status='won'`), agregados
 * aqui — mesmo padrão de enriquecimento client-side do board do kanban
 * (`withScores`/`withConversas`), não uma função SQL nova: o volume de
 * clientes de uma instalação self-host não pede isso, e duplicar a lógica
 * já pronta em `fn_sales_dashboard`'s `clientes` CTE custaria mais do que
 * reaproveitar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agregarComprasPorContato } from "@/lib/contacts/customer-aggregation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const LIMIT = 200;

export interface Customer {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  became_customer_at: string;
  ltv_cents: number;
  purchase_count: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "customers" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const search = new URL(req.url).searchParams.get("search")?.trim() ?? "";

  let query = supabase
    .from("contacts")
    .select("id, name, display_name, email, phone_number, became_customer_at")
    .eq("organization_id", authz.org.orgId)
    .not("became_customer_at", "is", null)
    .order("became_customer_at", { ascending: false })
    .limit(LIMIT);

  if (search) {
    // Mesmo escape de app/api/v1/contacts/_handler.ts: `%`/`_` são curingas
    // do LIKE, `,`/`(`/`)` são delimitadores do DSL do `.or()`.
    const s = search.replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, " ");
    query = query.or(
      [`name.ilike.%${s}%`, `display_name.ilike.%${s}%`, `phone_number.ilike.%${s}%`, `email.ilike.%${s}%`].join(
        ",",
      ),
    );
  }

  const { data: contatos, error: contatosErr } = await query;
  if (contatosErr) {
    return fail("internal_error", contatosErr.message, 500, { requestId });
  }

  const rows = (contatos ?? []) as Array<{
    id: string;
    name: string | null;
    display_name: string | null;
    email: string | null;
    phone_number: string | null;
    became_customer_at: string;
  }>;

  const ids = rows.map((r) => r.id);
  let porContato = new Map<string, { ltv_cents: number; purchase_count: number }>();
  if (ids.length > 0) {
    const { data: vendas, error: vendasErr } = await supabase
      .from("crm_leads")
      .select("contact_id, value_cents")
      .eq("organization_id", authz.org.orgId)
      .eq("status", "won")
      .in("contact_id", ids);
    if (vendasErr) {
      return fail("internal_error", vendasErr.message, 500, { requestId });
    }
    porContato = agregarComprasPorContato(vendas ?? []);
  }

  const customers: Customer[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    email: r.email,
    phone_number: r.phone_number,
    became_customer_at: r.became_customer_at,
    ltv_cents: porContato.get(r.id)?.ltv_cents ?? 0,
    purchase_count: porContato.get(r.id)?.purchase_count ?? 0,
  }));

  return ok(customers, { requestId });
}
