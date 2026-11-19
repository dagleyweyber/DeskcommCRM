/**
 * GET /api/v1/channels/templates/usos?name=... — quem usa o modelo (automações e
 * campanhas abertas). A tela de editar mostra isto ANTES de salvar: a edição
 * manda o modelo de volta para revisão, e quem depende dele precisa saber.
 *
 * É a mesma consulta do "apagar" (`usosDoModelo`), só que aqui informa em vez de barrar.
 *
 * `?channel_session_id=`: o número dono do modelo. Só conta o que sai por ele — o mesmo nome
 * pode existir em outro número da organização. O id só escolhe entre os números DESTA org.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { usosDoModelo } from "@/lib/channels/meta/apagar-modelo";
import { metaSessionEscolhida } from "@/lib/channels/meta/session";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const consulta = z.object({
  name: z.string().trim().min(1).max(512),
  channel_session_id: z.string().uuid().nullable(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }
  const parsed = consulta.safeParse({
    name: req.nextUrl.searchParams.get("name") ?? "",
    channel_session_id: req.nextUrl.searchParams.get("channel_session_id"),
  });
  if (!parsed.success) return fail("invalid_request", "Falta o nome do modelo.", 400, { requestId });

  // `organization_id` vem da sessão (resolveActiveOrg), nunca da query. O número, mesmo
  // pedido pela query, só vale se for desta organização.
  const sessao = await metaSessionEscolhida(org.orgId, parsed.data.channel_session_id);
  if (parsed.data.channel_session_id && !sessao) {
    return fail("not_found", "Número não encontrado nesta organização.", 404, { requestId });
  }
  const usos = await usosDoModelo(createAdminClient(), org.orgId, parsed.data.name, sessao?.id ?? null);
  return ok({ usos });
}
