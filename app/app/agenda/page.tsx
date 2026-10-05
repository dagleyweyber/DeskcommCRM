import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { AgendaClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Agenda (núcleo, Fase 1 — sem Google Calendar). `agent`+: é o mesmo piso
 * das rotas de `calendar_appointments` (RLS + `requireRole`).
 */
export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <p className="text-sm text-muted-foreground">Compromissos marcados com contatos.</p>
      </header>
      <AgendaClient />
    </div>
  );
}
