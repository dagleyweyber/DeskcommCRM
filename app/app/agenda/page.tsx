import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { AgendaClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Agenda por sala (migrations 0182 + 0200). `agent`+: é o mesmo piso das
 * rotas de `calendar_appointments` (RLS + `requireRole`).
 */
export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
      </header>
      <AgendaClient />
    </div>
  );
}
