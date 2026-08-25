import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { MetaAdsCredentialsRow } from "@/hooks/integrations/useMetaAdsCredentials";
import { MetaAdsIntegrationClient } from "./_client";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS = "id, organization_id, dataset_id, status, last_error, created_at, updated_at";

export default async function MetaAdsIntegrationPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("tenant_meta_ads_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Meta Ads</h1>
        <p className="text-sm text-muted-foreground">
          Conecte o Meta Ads pra que toda venda fechada no CRM vire um evento de
          "Purchase" no Conversions API automaticamente — sem precisar configurar
          nada além de conectar. O clique do anúncio (WhatsApp ou site) já é
          capturado no lead e vai junto, pra saber qual anúncio vendeu.
        </p>
      </header>
      <MetaAdsIntegrationClient
        initialData={(data as MetaAdsCredentialsRow | null) ?? null}
        canWrite={canWrite}
      />
    </div>
  );
}
