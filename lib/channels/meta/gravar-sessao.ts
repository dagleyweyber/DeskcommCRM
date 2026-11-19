/**
 * Grava a conexão de UM número oficial: atualiza (ou ressuscita) a linha desse número, ou
 * cria uma linha nova para ele. Nunca toca na linha de outro número.
 *
 * Os dois caminhos de conexão — credencial colada (`/channels/official`) e popup da Meta
 * (`/channels/official/embedded`) — gravam por aqui, para a regra de identidade ser uma só.
 * Antes cada rota procurava "a linha oficial da organização" e, numa org com um número já
 * conectado, conectar outro número regravava o primeiro (B'Laser Parnamirim, 2026-11-19: a
 * Recepção virou a Clara, parou de receber e o histórico da Clara caiu nas conversas dela).
 */
import { audit } from "@/lib/audit";
import type { CHANNEL_PROVIDER_META } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import type { createAdminClient } from "@/lib/supabase/admin";
import { metaSessionDoNumero } from "./session";

type Admin = ReturnType<typeof createAdminClient>;

export interface LinhaOficial {
  organization_id: string;
  provider: typeof CHANNEL_PROVIDER_META;
  meta_phone_number_id: string;
  [coluna: string]: unknown;
}

export type ResultadoGravacao =
  | { ok: true; channelSessionId: string; criada: boolean }
  | { ok: false; motivo: string };

export async function gravarSessaoOficial(
  admin: Admin,
  input: {
    linha: LinhaOficial;
    /** Segredo cifrado exigido (NOT NULL) só na criação da linha. */
    segredoCifrado: string;
    ator: { userId: string; requestId: string; metadata: Record<string, unknown> };
  },
): Promise<ResultadoGravacao> {
  const { linha } = input;
  const existente = await metaSessionDoNumero(admin, linha.organization_id, linha.meta_phone_number_id);

  if (existente) {
    const { error } = await reactivateChannelSession(
      admin,
      {
        organizationId: linha.organization_id,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at,
      },
      linha,
      input.ator,
    );
    if (error) return { ok: false, motivo: error.message ?? "channel_session_write_failed" };
    return { ok: true, channelSessionId: existente.id, criada: false };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({ ...linha, webhook_secret_encrypted: input.segredoCifrado })
    .select("id")
    .single();
  if (error || !data) return { ok: false, motivo: error?.message ?? "channel_session_write_failed" };
  // Número novo na organização deixa rastro: é o evento que faltou para reconstruir o que
  // aconteceu em Parnamirim (a sobrescrita não gerou nenhuma linha de auditoria).
  void audit({
    action: "channel.connected",
    actorUserId: input.ator.userId,
    organizationId: linha.organization_id,
    resourceType: "channel_session",
    resourceId: data.id as string,
    requestId: input.ator.requestId,
    metadata: input.ator.metadata,
  });
  return { ok: true, channelSessionId: data.id as string, criada: true };
}
