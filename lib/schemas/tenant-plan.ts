/**
 * Vocabulário de plano de tenant — fonte única.
 *
 * Não é CHECK de banco (o valor mora em `organizations.settings.plan`, jsonb),
 * então a única coisa que impede um `enterprice` de string solta é este módulo
 * ser importado nos dois lados que hoje escrevem plano: a criação do tenant
 * (`tenants/route.ts`) e a troca posterior (`tenants/[id]/plan/route.ts`).
 */
import { z } from "zod";

export const TENANT_PLANS = ["standard", "pro", "enterprise"] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

export const tenantPlanSchema = z.enum(TENANT_PLANS);

export const TENANT_PLAN_LABEL: Record<TenantPlan, string> = {
  standard: "Standard",
  pro: "Pro",
  enterprise: "Enterprise",
};

/** Lê `organizations.settings.plan` com segurança — jsonb não garante o vocabulário. */
export function tenantPlanFromSettings(settings: unknown): TenantPlan | null {
  const raw = (settings as { plan?: unknown } | null)?.plan;
  return typeof raw === "string" && (TENANT_PLANS as readonly string[]).includes(raw)
    ? (raw as TenantPlan)
    : null;
}
