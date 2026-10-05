import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { EventTypesClient } from "./_client";

export const dynamic = "force-dynamic";

/** manager+: mesmo piso de `calendar_event_types_write` na RLS (migration 0182). */
export default async function AgendaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tipos de compromisso</h1>
        <p className="text-sm text-muted-foreground">
          Os tipos de compromisso que aparecem ao marcar na Agenda — duração, antecedência mínima e janela de agendamento de cada um.
        </p>
      </header>
      <EventTypesClient />
    </div>
  );
}
