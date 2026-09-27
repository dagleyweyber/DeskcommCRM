import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { TarefasClient } from "./_components/TarefasClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tarefas" };

/**
 * TAREFAS — "ligar de volta na terça", num lugar que não é a memória de ninguém.
 *
 * Lembrete de trabalho INTERNO, distinto de compromisso agendado com o
 * cliente (não temos módulo de Agenda neste fork).
 *
 * ─── Quem pode o quê ───────────────────────────────────────────────────────
 *
 * `viewer` VÊ as tarefas: saber o que o time combinou é informação de operação.
 * Criar e editar é `agent` — e a rota cobra de novo (`requireRole("agent")`).
 * A tela esconder o botão é cortesia, não autorização.
 */
export default async function TarefasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  return <TarefasClient podeEditar={podeEditar} />;
}
