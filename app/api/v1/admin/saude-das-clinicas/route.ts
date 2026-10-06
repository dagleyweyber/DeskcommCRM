/**
 * GET /api/v1/admin/saude-das-clinicas
 *
 * Saúde de TODAS as organizações numa resposta. Irmã de
 * `admin/tenants/[id]/health` (uma organização, 4 consultas) — aqui é uma
 * chamada só, agregada no banco por `fn_saude_das_clinicas()` (migration
 * 0186), para que o custo não cresça com o número de clínicas.
 *
 * Path próprio (`saude-das-clinicas`) e não `tenants/health`: ali o segmento
 * seria irmão de `tenants/[id]`, e "health" passaria a parecer um id de
 * organização para quem lê a rota.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classificaClinica,
  ordenaPorGravidade,
  tiposAcionaveis,
  type SinaisDaClinica,
} from "@/lib/admin/saude-das-clinicas";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_saude_das_clinicas" as never, {
    p_tipos_acionaveis: tiposAcionaveis(),
  } as never);

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const agora = new Date();
  const clinicas = ordenaPorGravidade(
    ((data ?? []) as unknown as SinaisDaClinica[]).map((linha) =>
      classificaClinica(linha, agora),
    ),
  );

  // Contagem por gravidade: é o que o topo da tela mostra, e o que um alerta
  // futuro (item 3 do plano) consumiria sem reclassificar nada.
  const resumo = {
    total: clinicas.length,
    critico: clinicas.filter((c) => c.geral === "critico").length,
    atencao: clinicas.filter((c) => c.geral === "atencao").length,
    ok: clinicas.filter((c) => c.geral === "ok").length,
    suspenso: clinicas.filter((c) => c.geral === "suspenso").length,
  };

  void audit({
    action: "platform_admin.saude_das_clinicas_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
  });

  return ok({ resumo, clinicas, apurado_em: agora.toISOString() }, { requestId });
}
