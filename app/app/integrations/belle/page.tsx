import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

import { BelleClient, type ConexaoBelle } from "./_client";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, credential_last4, external_account_id, external_account_name, default_area_code, status, last_error, last_sync_at, last_sync_stats, initial_sync_done_at, created_at, updated_at";

export default async function BellePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data } = await supabase
    .from("calendar_integrations_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "belle")
    .maybeSingle();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Belle Software</h1>
        <p className="text-sm text-muted-foreground">
          Traga para a Agenda, sozinho, todo agendamento feito no Belle — data, horário, sala, serviço e
          cliente. O Belle continua sendo onde se marca, remarca e cancela; a Agenda do CRM espelha e
          atualiza a cada 10 minutos.
        </p>
      </header>
      <BelleClient initialData={(data as ConexaoBelle | null) ?? null} canWrite={ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin} />
    </div>
  );
}
