/**
 * GET/POST /api/v1/cron/ai-handoff-timeout-watcher — devolve ao agente de IA
 * a conversa que ficou esquecida com um humano.
 *
 * Achado auditando o CHANGELOG do fornecedor: eles mediram, numa instalação
 * real, 12 de 31 conversas ativas num dia paradas com um humano que assumiu
 * e nunca devolveu. `lib/escalacao/retomada.ts` (devolverAtendimentoAoAgente)
 * já resolve a devolução em si sem furo (as três travas: force_human,
 * assignee_kind, bot_silenced_until); faltava o GATILHO automático por
 * prazo — hoje só existe o botão manual em cada conversa.
 *
 * Configuração é OPT-IN por organização — `organizations.settings.routing.
 * human_handoff_timeout_minutes` (tela Configurações › Distribuição de
 * atendimento), 0 = desligado, o padrão pra toda instalação, inclusive quem
 * já tem o sistema. `fn_conversas_para_devolver_ao_agente` (migration 0176)
 * resolve "quem está devida" via SQL: prazo vencido desde o último sinal da
 * equipe, e só onde existe agente publicado pro canal daquela conversa.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface Devida {
  conversation_id: string;
  organization_id: string;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("fn_conversas_para_devolver_ao_agente" as never, {} as never);
  if (error) {
    logger.error("[ai-handoff-timeout-watcher] rpc failed", { detail: error.message, requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const devidas = (data ?? []) as Devida[];
  let devolvidas = 0;

  for (const d of devidas) {
    const resultado = await devolverAtendimentoAoAgente(
      {
        supabase: admin,
        organizationId: d.organization_id,
        // O produto agiu, não uma pessoa nem o modelo — mesma convenção de
        // `lib/leads/activity-emitter.ts` (mapActorParaAtividade) pra ação de
        // sistema: webhook_source e afins caem em "system", sem FK nenhuma
        // presa ao `id`.
        actor: { type: "webhook_source", id: "cron:ai-handoff-timeout-watcher" },
        requestId,
      },
      { conversationId: d.conversation_id },
    );

    if (!resultado.ok) {
      // assignment_conflict é esperado (alguém respondeu/assumiu entre o SELECT
      // e aqui) — não é falha do watcher, é a corrida sendo resolvida a favor
      // de quem chegou primeiro. Só loga o que não é essa corrida.
      if (resultado.erro !== "assignment_conflict") {
        logger.warn("[ai-handoff-timeout-watcher] devolução falhou", {
          conversation_id: d.conversation_id,
          organization_id: d.organization_id,
          erro: resultado.erro,
          detalhe: resultado.detalhe,
          requestId,
        });
      }
      continue;
    }
    devolvidas++;
  }

  return ok({ scanned: devidas.length, returned: devolvidas }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
