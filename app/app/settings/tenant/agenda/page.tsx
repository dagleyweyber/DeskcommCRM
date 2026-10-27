import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { AgendaSettingsClient } from "./_client";

export const dynamic = "force-dynamic";

/** manager+: mesmo piso de `calendar_rooms_write`/`calendar_event_types_write` na RLS (migrations 0182/0200). */
export default async function AgendaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <p className="text-sm text-muted-foreground">
          Salas, horário de funcionamento, serviços e bloqueios — é daqui que a Agenda e o agente de IA tiram os horários livres.
        </p>
      </header>
      <AgendaSettingsClient />
    </div>
  );
}
