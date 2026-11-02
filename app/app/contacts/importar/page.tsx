import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ImportarContatosClient } from "./_client";

export const dynamic = "force-dynamic";

/** Mesmo papel da rota POST /api/v1/contacts/import — ver o cabeçalho dela. */
export default async function ImportarContatosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return <ImportarContatosClient />;
}
