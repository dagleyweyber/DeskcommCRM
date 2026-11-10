/**
 * GET /api/v1/campaigns/numeros — a saúde de cada número da API oficial, para o painel da aba
 * Disparos: nota de qualidade, limite de contatos por 24 h e quantas campanhas estão andando.
 *
 * A nota e o limite vêm da checagem de saúde (a cada 5 min) e do aviso de qualidade do número
 * da Meta (`channel_sessions.meta_quality_*`, migration 0218).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "whatsapp_campaigns" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessoes, error } = await admin
    .from("channel_sessions")
    .select("id, display_name, phone_number, status, meta_quality_rating, meta_messaging_limit, meta_quality_event, meta_quality_updated_at")
    .eq("organization_id", authz.org.orgId)
    .not("meta_phone_number_id", "is", null)
    .is("archived_at", null)
    .order("display_name", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const { data: andando } = await admin
    .from("whatsapp_campaigns")
    .select("channel_session_id")
    .eq("organization_id", authz.org.orgId)
    .in("status", ["queued", "running"]);
  const campanhasAndando = new Map<string, number>();
  for (const c of (andando ?? []) as Array<{ channel_session_id: string }>) {
    campanhasAndando.set(c.channel_session_id, (campanhasAndando.get(c.channel_session_id) ?? 0) + 1);
  }

  return ok(
    {
      numeros: (sessoes ?? []).map((s) => ({
        id: s.id,
        nome: s.display_name ?? s.phone_number ?? "Sem nome",
        telefone: s.phone_number,
        conectado: s.status === "WORKING",
        qualidade: s.meta_quality_rating,
        limite: s.meta_messaging_limit,
        ultimo_evento: s.meta_quality_event,
        atualizado_em: s.meta_quality_updated_at,
        campanhas_andando: campanhasAndando.get(s.id) ?? 0,
      })),
    },
    { requestId },
  );
}
