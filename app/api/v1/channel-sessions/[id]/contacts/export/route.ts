/**
 * GET /api/v1/channel-sessions/[id]/contacts/export — CSV dos contatos de UMA
 * conexão de WhatsApp.
 *
 * Duas fontes, escolhidas por `?fonte=`:
 *  - `agenda` (padrão): tudo o que o WhatsApp do número conhece — salvos e não
 *    salvos —, lido do canal na hora e descartado depois do download. Nada é
 *    gravado no CRM. Só existe para canal que guarda agenda (`listAddressBook`
 *    no adapter), e só se este número foi pareado já guardando-a.
 *  - `conversas`: só quem tem conversa DENTRO do CRM (o que a exportação sempre
 *    fez). Funciona em qualquer número, inclusive os pareados antes de a agenda
 *    passar a ser guardada.
 *
 * Thin wrapper: papel + canal da organização + CSV + auditoria. A busca mora em
 * `lib/channels/` (agenda) e `lib/contacts/contatos-do-canal.ts` (conversas), e o
 * formato em `lib/contacts/exportacao.ts`.
 *
 * `manager`+: é dado pessoal saindo em massa (LGPD) — mesmo piso da importação.
 * Cada download vira `contacts.exported` na auditoria com quem baixou, de que
 * fonte e QUANTOS contatos — nunca nome nem telefone.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { AgendaGrandeDemaisError, AgendaIndisponivelError } from "@/lib/channels/agenda";
import { contatosDoCanal, LimiteDeExportacaoError } from "@/lib/contacts/contatos-do-canal";
import { montarCsv, montarCsvAgenda, nomeDoArquivo } from "@/lib/contacts/exportacao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const fonteSchema = z.enum(["agenda", "conversas"]).default("agenda");

function csv(corpo: string, arquivo: string, requestId: string): Response {
  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${arquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const fonte = fonteSchema.safeParse(req.nextUrl.searchParams.get("fonte") ?? undefined);
  if (!fonte.success) return fail("validation_failed", "Fonte inválida.", 422, { requestId });

  const supabase = await createClient();
  const { data: canal } = await supabase
    .from("channel_sessions")
    .select(`id, display_name, phone_number, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id.data)
    .maybeSingle();
  if (!canal) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const rotulo = canal.display_name ?? canal.phone_number ?? "canal";

  if (fonte.data === "conversas") {
    let linhas;
    try {
      linhas = await contatosDoCanal(supabase, authz.org.orgId, canal.id);
    } catch (err) {
      if (err instanceof LimiteDeExportacaoError) {
        return fail("payload_too_large", err.message, 413, { requestId });
      }
      return fail("internal_error", err instanceof Error ? err.message : "export_failed", 500, {
        requestId,
      });
    }

    await audit({
      action: "contacts.exported",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: canal.id,
      requestId,
      metadata: { actor_type: "user", fonte: "conversas", contatos: linhas.length },
    });
    return csv(montarCsv(linhas), nomeDoArquivo(rotulo, new Date()), requestId);
  }

  // Agenda: pergunta-se ao adapter se o canal guarda uma — nunca QUAL canal é.
  const adapter = getAdapter(canal.provider as ChannelProvider);
  if (!adapter.listAddressBook) {
    return fail(
      "channel_without_address_book",
      "Este canal não entrega a lista de contatos do WhatsApp. Baixe só quem conversou no CRM, ou exporte a agenda pelo celular e importe em Contatos → Importar.",
      422,
      { requestId },
    );
  }
  if (!adapter.isConfigured()) {
    return fail(
      "channel_not_configured",
      "O serviço de WhatsApp não está configurado neste ambiente.",
      503,
      { requestId },
    );
  }

  let agenda;
  try {
    agenda = await adapter.listAddressBook({
      sessionRef: resolveSessionRef(canal as unknown as ChannelSessionRef),
    });
  } catch (err) {
    if (err instanceof AgendaIndisponivelError) {
      return fail(
        "address_book_unavailable",
        "Este número foi conectado antes de o CRM guardar a agenda do WhatsApp, então não há lista para exportar. É preciso conectar o número de novo (novo QR) para ativar — depois disso a agenda é sincronizada. Enquanto isso, dá para baixar só quem conversou no CRM.",
        409,
        { requestId },
      );
    }
    if (err instanceof AgendaGrandeDemaisError) {
      return fail("payload_too_large", err.message, 413, { requestId });
    }
    return fail("channel_error", "Não foi possível ler a agenda do WhatsApp agora. Tente de novo em instantes.", 502, {
      requestId,
    });
  }

  if (agenda.linhas.length === 0) {
    return fail(
      "address_book_not_ready",
      "O WhatsApp ainda não sincronizou a agenda deste número. Isso leva alguns minutos depois de conectar — tente de novo daqui a pouco.",
      409,
      { requestId },
    );
  }

  const salvos = agenda.linhas.filter((l) => l.salvo).length;
  await audit({
    action: "contacts.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: canal.id,
    requestId,
    metadata: {
      actor_type: "user",
      fonte: "agenda",
      contatos: agenda.linhas.length,
      salvos,
      nao_salvos: agenda.linhas.length - salvos,
      sem_telefone: agenda.sem_telefone,
    },
  });

  return csv(montarCsvAgenda(agenda.linhas), nomeDoArquivo(rotulo, new Date(), "agenda"), requestId);
}
