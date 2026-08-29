/**
 * GET /api/v1/metrics/sales — Dashboard de Vendas (Fases 1+2+3+4 + Meta Ads
 * Fase E3: KPIs, gráficos de período/origem/serviço, principais objeções,
 * funil real de agendamento → presença → conversão, e receita por anúncio
 * — agora com campanha/conjunto e agendamentos por anúncio). Mesmo esqueleto
 * de /api/v1/metrics/attendants.
 *
 * Escopo = a PRÓPRIA RLS: `fn_sales_dashboard` (SECURITY INVOKER) roda com o
 * client user-scoped (cookie session), então crm_leads (fn_can_view_lead) já
 * filtra por atendente. agent ⇒ só os próprios leads entram na agregação;
 * manager+ ⇒ org-wide. Piso de rota = agent. org da org ativa (cookie
 * validado), NUNCA do body/query. Read-only ⇒ sem audit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  pipeline_id: z.string().uuid().optional(),
  source: z.string().min(1).optional(),
});

interface SalesKpis {
  leads_total: number;
  vendas: number;
  receita_total_cents: number;
  valor_medio_cents: number | null;
  conversao_pct: number | null;
  tempo_conversao_medio_dias: number | null;
  /** LIFETIME — não filtrado por from/to (Fase 5 de "cliente já existente"). */
  ltv_medio_cents: number | null;
  taxa_recompra_pct: number | null;
}

interface LeadsPorDia {
  dia: string;
  criados: number;
  convertidos: number;
}

interface ReceitaPorOrigem {
  origem: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}

interface ReceitaPorServico {
  servico: string;
  leads: number;
  vendas: number;
  receita_cents: number;
}

interface PrincipalObjecao {
  motivo: string;
  quantidade: number;
}

interface FunilAgendamento {
  agendados: number;
  compareceram: number;
  nao_compareceram: number;
  compareceram_e_fecharam: number;
  taxa_comparecimento_pct: number | null;
}

interface ReceitaPorAnuncio {
  anuncio: string;
  ad_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  leads: number;
  vendas: number;
  agendamentos: number;
  receita_cents: number;
}

interface SalesDashboardPayload {
  kpis: SalesKpis;
  leads_por_dia: LeadsPorDia[];
  receita_por_origem: ReceitaPorOrigem[];
  receita_por_servico: ReceitaPorServico[];
  principais_objecoes: PrincipalObjecao[];
  funil_agendamento: FunilAgendamento;
  receita_por_anuncio: ReceitaPorAnuncio[];
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    pipeline_id: url.searchParams.get("pipeline_id") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", "Janela inválida: 'from' deve ser anterior a 'to'.", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_sales_dashboard", {
    p_org: activeOrg.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_pipeline_id: parsed.data.pipeline_id,
    p_source: parsed.data.source,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const dashboard = (data ?? {
    kpis: {
      leads_total: 0,
      vendas: 0,
      receita_total_cents: 0,
      valor_medio_cents: null,
      conversao_pct: null,
      tempo_conversao_medio_dias: null,
      ltv_medio_cents: null,
      taxa_recompra_pct: null,
    },
    leads_por_dia: [],
    receita_por_origem: [],
    receita_por_servico: [],
    principais_objecoes: [],
    funil_agendamento: {
      agendados: 0,
      compareceram: 0,
      nao_compareceram: 0,
      compareceram_e_fecharam: 0,
      taxa_comparecimento_pct: null,
    },
    receita_por_anuncio: [],
  }) as unknown as SalesDashboardPayload;

  return ok(
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      pipeline_id: parsed.data.pipeline_id ?? null,
      source: parsed.data.source ?? null,
      kpis: dashboard.kpis,
      leads_por_dia: dashboard.leads_por_dia,
      receita_por_origem: dashboard.receita_por_origem,
      receita_por_servico: dashboard.receita_por_servico,
      principais_objecoes: dashboard.principais_objecoes,
      funil_agendamento: dashboard.funil_agendamento,
      receita_por_anuncio: dashboard.receita_por_anuncio,
    },
    { requestId },
  );
}
