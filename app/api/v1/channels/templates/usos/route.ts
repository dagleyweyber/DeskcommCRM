/**
 * GET /api/v1/channels/templates/usos?name=... — quem usa o modelo (automações e
 * campanhas abertas). A tela de editar mostra isto ANTES de salvar: a edição
 * manda o modelo de volta para revisão, e quem depende dele precisa saber.
 *
 * É a mesma consulta do "apagar" (`usosDoModelo`), só que aqui informa em vez de barrar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { usosDoModelo } from "@/lib/channels/meta/apagar-modelo";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const consulta = z.object({ name: z.string().trim().min(1).max(512) });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }
  const parsed = consulta.safeParse({ name: req.nextUrl.searchParams.get("name") ?? "" });
  if (!parsed.success) return fail("invalid_request", "Falta o nome do modelo.", 400, { requestId });

  // `organization_id` vem da sessão (resolveActiveOrg), nunca da query.
  const usos = await usosDoModelo(createAdminClient(), org.orgId, parsed.data.name);
  return ok({ usos });
}
