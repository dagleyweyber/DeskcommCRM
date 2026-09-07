import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CampaignsClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Campanhas</h1>
        <p className="text-sm text-muted-foreground">
          Dispare um template aprovado pra uma tag ou etapa do funil inteira — respeitando o
          mesmo limite diário, horário e espaçamento entre envios que protege seus números do
          resto do CRM.
        </p>
      </header>
      <CampaignsClient />
    </div>
  );
}
