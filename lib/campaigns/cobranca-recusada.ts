/**
 * Freio de COBRANÇA: campanha que a Meta recusa por pagamento para sozinha.
 *
 * A Meta aceita o pedido de envio e só minutos depois devolve a falha de entrega (webhook de status),
 * então o despachante marca `sent` e segue. Sem cartão ou moeda na conta do WhatsApp o erro é o
 * 131042 em TODAS as mensagens: em 2026-11-09 uma campanha de 2.000 foi inteira para a Meta e nenhuma
 * chegou ao cliente, sem que nada a interrompesse. O freio por falha seguida de `velocidade.ts` não
 * pega isso — ele só vê falha síncrona.
 *
 * A cada rodada, antes de mandar, olha o resultado real das últimas mensagens enviadas da campanha:
 * se a maioria voltou com 131042, pausa a campanha e abre um aviso crítico na Central. Retomar é o
 * botão "Retomar" da tela, depois de o operador acertar a cobrança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { registrarAviso } from "@/lib/channels/aviso-de-canal";

/** "Business eligibility payment issue" — cartão ou moeda ausentes na conta do WhatsApp Business. */
export const CODIGO_META_COBRANCA = 131042;

/** Quantas das últimas mensagens enviadas entram na conta, e quantas recusadas bastam para pausar. */
export const AMOSTRA_DE_ENVIOS = 5;
export const RECUSAS_PARA_PAUSAR = 3;

export interface CampanhaParaFreio {
  id: string;
  organization_id: string;
  channel_session_id: string;
  name?: string | null;
}

/** A Meta recusou a cobrança da maioria das últimas mensagens desta campanha? */
export async function cobrancaRecusada(admin: SupabaseClient, campanha: CampanhaParaFreio): Promise<boolean> {
  const { data: ultimos } = await admin
    .from("whatsapp_campaign_recipients")
    .select("external_id")
    .eq("campaign_id", campanha.id)
    .eq("status", "sent")
    .not("external_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(AMOSTRA_DE_ENVIOS);
  const ids = ((ultimos ?? []) as Array<{ external_id: string | null }>)
    .map((l) => l.external_id)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return false;

  const { data: falhas } = await admin
    .from("messages")
    .select("metadata")
    .eq("organization_id", campanha.organization_id)
    .eq("status", "failed")
    .in("external_id", ids);
  const recusadas = ((falhas ?? []) as Array<{ metadata: { failure_code?: unknown } | null }>).filter(
    (m) => Number(m.metadata?.failure_code) === CODIGO_META_COBRANCA,
  );
  return recusadas.length >= RECUSAS_PARA_PAUSAR;
}

/** Se a cobrança foi recusada, pausa a campanha e avisa; devolve se pausou. */
export async function pausarSeCobrancaRecusada(
  admin: SupabaseClient,
  campanha: CampanhaParaFreio,
): Promise<boolean> {
  if (!(await cobrancaRecusada(admin, campanha))) return false;

  // Só pausa o que ainda está andando: cancelar ou completar à mão não pode ser desfeito aqui.
  await admin
    .from("whatsapp_campaigns")
    .update({ status: "paused" })
    .eq("id", campanha.id)
    .eq("organization_id", campanha.organization_id)
    .eq("status", "running"); // o tick já promoveu `queued` → `running` antes de chegar aqui

  const { data: canal } = await admin
    .from("channel_sessions")
    .select("display_name")
    .eq("id", campanha.channel_session_id)
    .eq("organization_id", campanha.organization_id)
    .maybeSingle();
  const nomeDoCanal = (canal as { display_name?: string | null } | null)?.display_name ?? "um canal";

  await registrarAviso(admin, campanha.organization_id, {
    kind: "channel_number_alert",
    severity: "critical",
    title: `Envio pausado em ${nomeDoCanal}: a Meta recusou a cobrança`,
    body:
      `A campanha "${campanha.name ?? campanha.id}" foi pausada porque as últimas mensagens voltaram com o erro ` +
      `${CODIGO_META_COBRANCA} (pagamento). Confira o cartão e a moeda da conta do WhatsApp Business no Gerenciador ` +
      "da Meta. As mensagens recusadas não chegaram aos clientes; depois de corrigir, retome a campanha.",
  });
  return true;
}
