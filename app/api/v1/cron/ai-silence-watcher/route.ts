/**
 * GET/POST /api/v1/cron/ai-silence-watcher — detecta agente de IA publicado
 * e ativo que parou de responder, e abre aviso na Central.
 *
 * Achado auditando o CHANGELOG do fornecedor (`melgarafael/DeskcommCRM`) —
 * mesma classe de bug que eles corrigiram ("processamento que para de tentar
 * agora aparece na Central de avisos") — e confirmado ao vivo em produção:
 * um agente publicado e ativo pode ficar semanas sem responder ninguém
 * (versão publicada sem credencial, entre outras causas estruturais) sem
 * NENHUM sinal em lugar nenhum. `fn_ia_organizacoes_silenciosas` resolve os
 * dois casos via SQL (ver migration 0175):
 *
 *   - "sem_credencial": a versão publicada não tem credencial vinculada —
 *     nunca vai responder, config estrutural, não transitória.
 *   - "sem_atividade": chegou mensagem de cliente recente e não há NENHUMA
 *     atividade correspondente (ai_agent_runs nem ai_invocations) na mesma
 *     janela — silêncio de verdade, não lentidão do pipeline.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Janela de checagem — mesma escala dos demais watchers periódicos. */
const JANELA_MINUTOS = 60;

interface OrgSilenciosa {
  organization_id: string;
  motivo: "sem_credencial" | "sem_atividade";
  agent_id: string;
}

const TITULO_POR_MOTIVO: Record<OrgSilenciosa["motivo"], { title: string; body: string }> = {
  sem_credencial: {
    title: "Agente de IA publicado sem credencial — ninguém está sendo respondido",
    body:
      "A versão publicada deste agente não tem uma chave de IA vinculada. Cadastre a chave em " +
      "Agente de IA › Credenciais e edite + publique o agente de novo para vinculá-la.",
  },
  sem_atividade: {
    title: "A IA parou de responder mensagens de cliente",
    body:
      "Chegou mensagem de cliente nesta hora e não há nenhum registro de execução do agente " +
      "no mesmo período. Confira Agente de IA › Execuções para o motivo.",
  },
};

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc(
    "fn_ia_organizacoes_silenciosas" as never,
    { p_janela_minutos: JANELA_MINUTOS } as never,
  );

  if (error) {
    logger.error("[ai-silence-watcher] rpc failed", { detail: error.message, requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const silenciosas = (data ?? []) as OrgSilenciosa[];
  let abertos = 0;

  for (const s of silenciosas) {
    // Dedup: só um aviso ABERTO deste motivo por organização — mesmo padrão
    // já usado em avisarMidiaNaoLida (media-derive-worker) e budget_exceeded.
    // O `ref_id` carrega o motivo dentro do agent_id pra não colidir os dois
    // motivos possíveis do mesmo agente num só "já aberto".
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", s.organization_id)
      .eq("kind", "ia_sem_resposta")
      .eq("ref_id", s.agent_id)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) continue;

    const texto = TITULO_POR_MOTIVO[s.motivo];
    const { error: insertErr } = await admin.from("agent_inbox_items").insert({
      organization_id: s.organization_id,
      kind: "ia_sem_resposta",
      severity: "critical",
      title: texto.title,
      body: texto.body,
      ref_kind: "ai_agent",
      ref_id: s.agent_id,
    });
    if (insertErr) {
      logger.error("[ai-silence-watcher] insert failed", {
        organization_id: s.organization_id,
        detail: insertErr.message,
        requestId,
      });
      continue;
    }
    abertos++;
  }

  return ok({ scanned: silenciosas.length, opened: abertos }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
