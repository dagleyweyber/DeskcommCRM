/**
 * GET/POST /api/v1/cron/agenda-externa — importa os agendamentos do Belle.
 *
 * Uma rodada passa pelas conexões da mais atrasada para a mais recente e para ao
 * estourar o ORÇAMENTO de tempo: o Belle leva de 10 a 30 s por janela, e o curl
 * do scheduler desiste em 110 s. Quem não coube nesta rodada é o primeiro da
 * próxima (ordem por `last_sync_at`, nulos primeiro).
 *
 * Conexão `invalid` (token recusado) fica de fora até alguém colar um token novo
 * na tela — insistir só gastaria o limite de requisições do Belle.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { sincronizarIntegracao, type Integracao } from "@/lib/agenda-externa/sincronizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Não começa uma conexão nova depois disto (ms desde o início da rodada). */
const ORCAMENTO_MS = 55_000;
const LIMITE_DE_CONEXOES = 20;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_integrations")
    .select("id, organization_id, credential_encrypted, external_account_id, default_area_code, initial_sync_done_at, far_window_index")
    .neq("status", "invalid")
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(LIMITE_DE_CONEXOES);
  if (error) return fail("internal_error", "Falha ao listar as conexões.", 500, { requestId });

  const inicio = Date.now();
  const rodadas: { organization_id: string; ok: boolean; criados: number; atualizados: number }[] = [];
  for (const integ of (data ?? []) as Integracao[]) {
    if (Date.now() - inicio > ORCAMENTO_MS) break;
    const r = await sincronizarIntegracao(admin, integ);
    rodadas.push({ organization_id: integ.organization_id, ok: r.ok, criados: r.contagem.criados, atualizados: r.contagem.atualizados });
  }

  return ok({ sincronizadas: rodadas.length, pendentes: (data?.length ?? 0) - rodadas.length, rodadas }, { requestId });
}

export const GET = handle;
export const POST = handle;
