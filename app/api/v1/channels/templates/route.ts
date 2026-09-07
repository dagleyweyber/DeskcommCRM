/**
 * GET  /api/v1/channels/templates — o espelho local + o CONTRATO derivado de cada um.
 * POST /api/v1/channels/templates — força um sync com a Graph API.
 *
 * O contrato vai derivado no payload, e não guardado no banco, de propósito: guardar
 * o derivado criaria a segunda fonte da verdade que esta fase inteira existe para
 * eliminar. A tela e o montador de envio chamam a MESMA `deriveTemplateContract`.
 *
 * Nenhum campo aqui é "quantidade de parâmetros". O número é consequência dos slots;
 * se algum dia aparecer um campo editável com esse nome, o desenho vazou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { getAdapter } from "@/lib/channels";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import { normalizeRejectedReason } from "@/lib/channels/meta/webhook";
import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Um template pronto para a tela: o que a Meta diz + o contrato derivado. */
export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  slots: Array<{
    key: string;
    expects: string;
    onde: string;
  }>;
  /**
   * Texto de cada componente que carrega parâmetro, INTEIRO e uma vez só.
   * Antes a tela mostrava o corpo repetido a cada slot, cada linha destacando o
   * seu e deixando o vizinho cru — correto e ilegível. A UI marca os `{{n}}`.
   */
  previews: Array<{ onde: string; text: string }>;
  /** A definição crua — de onde sai o texto que vai no corpo do envio. */
  components: unknown[];
}

/** Textos com placeholder, achatados (inclui os de dentro de card de carrossel). */
function textPreviews(components: unknown): Array<{ onde: string; text: string }> {
  const out: Array<{ onde: string; text: string }> = [];
  const visita = (lista: unknown, prefixo: string) => {
    if (!Array.isArray(lista)) return;
    for (const c of lista as Array<Record<string, unknown>>) {
      const tipo = String(c.type ?? "").toUpperCase();
      if (Array.isArray(c.cards)) {
        (c.cards as Array<Record<string, unknown>>).forEach((card, i) =>
          visita(card.components, `card ${i + 1} › `),
        );
        continue;
      }
      const texto = typeof c.text === "string" ? c.text : "";
      if (!texto.includes("{{")) continue;
      out.push({ onde: `${prefixo}${tipo === "HEADER" ? "cabeçalho" : "corpo"}`, text: texto });
    }
  };
  visita(components, "");
  return out;
}

type OrgGate =
  | { autorizado: true; orgId: string }
  | { autorizado: false; resposta: NextResponse };

async function orgOrFail(requestId: string): Promise<OrgGate> {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return {
      autorizado: false,
      resposta: fail("forbidden", "admin_required", 403, { requestId }),
    };
  }
  return { autorizado: true, orgId: activeOrg.orgId };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  const sessao = await metaSessionForOrg(r.orgId);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select(
      "name, language, status, category, rejected_reason, quality_score, parameter_format, contract_hash, components, synced_at",
    )
    .eq("organization_id", r.orgId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const templates: TemplateView[] = (data ?? []).map((row) => {
    const contrato = deriveTemplateContract({
      name: row.name,
      language: row.language,
      parameter_format: row.parameter_format,
      components: row.components as never,
    });
    return {
      name: row.name,
      language: row.language,
      status: row.status,
      category: row.category,
      // Normaliza na LEITURA também: o "NONE" da Meta pode ter sido gravado por
      // uma versão anterior ao conserto, e um clone atualizado ainda o carrega.
      rejectedReason: normalizeRejectedReason(row.rejected_reason),
      qualityScore: row.quality_score,
      parameterFormat: contrato.parameterFormat,
      contractHash: row.contract_hash,
      syncedAt: row.synced_at,
      slots: contrato.slots.map((s) => ({
        key: s.key,
        expects: s.expects,
        onde: describeAddress(s.address),
      })),
      previews: textPreviews(row.components),
      // A DEFINIÇÃO crua, como a rota do canal intermediado já devolve.
      //
      // `previews` não serve para isto: ele filtra por `{{` (só interessa
      // mostrar o que tem variável), então um modelo SEM variável sai com a
      // lista vazia — e são exatamente esses que o operador consegue disparar
      // sem preencher nada. O seletor da janela fechada monta o corpo da
      // mensagem a partir daqui; sem o campo, ele caía no NOME TÉCNICO do
      // modelo e era isso que o cliente recebia.
      components: (row.components as unknown[]) ?? [],
    };
  });

  return ok({
    // `null` aqui não é "erro": é o estado de quem não tem canal oficial ATIVO —
    // nunca conectou, ou conectou e excluiu —, e a tela precisa distingui-lo de
    // "conectado, porém sem template".
    waba: sessao?.wabaId ?? null,
    // A tela de campanhas precisa do id da SESSÃO (não só da WABA) pra gravar
    // em `whatsapp_campaigns.channel_session_id` — sem isto ela teria que
    // adivinhar qual sessão bate com esta WABA.
    channelSessionId: sessao?.id ?? null,
    templates,
  });
}

/**
 * Sincroniza com a Meta, ou CRIA uma definição nova antes de sincronizar.
 *
 * Achado ao vivo (RevitaFio Mossoró): esta rota lia `META_SYSTEM_USER_TOKEN`
 * do ambiente direto — o mesmo bug corrigido em `adapters/meta-cloud.ts`. Uma
 * instalação que conecta pela tela ("Conectar canal oficial") guarda a
 * credencial na SESSÃO, não no `.env`, e "Sincronizar com a Meta" falhava com
 * `missing_meta_token` para todo canal conectado assim — silenciosamente,
 * porque a tela não distinguia "sem canal" de "canal sem token no ambiente".
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  const sessao = await metaSessionForOrg(r.orgId);
  if (!sessao?.wabaId || !sessao.phoneNumberId) {
    return fail("invalid_request", "no_meta_channel", 400, { requestId });
  }

  const admin = createAdminClient();
  const creds = await resolveMetaCreds(admin, sessao.phoneNumberId);
  if (!creds) return fail("invalid_request", "missing_meta_token", 400, { requestId });

  const corpo = (await req.json().catch(() => ({}))) as {
    acao?: string;
    name?: string;
    language?: string;
    category?: string;
    components?: unknown[];
  };

  try {
    if (corpo.acao === "criar") {
      if (!corpo.name || !corpo.language || !Array.isArray(corpo.components)) {
        return fail("invalid_request", "Faltam nome, idioma ou conteúdo.", 400, { requestId });
      }
      const adapter = getAdapter(CHANNEL_PROVIDER_META);
      if (!adapter.templates) {
        return fail("not_implemented", "Este canal não gerencia definições.", 501, { requestId });
      }
      // A plataforma valida formato do nome e conteúdo — a recusa dela chega
      // inteira ao operador. Não duplicamos a regra: regra copiada envelhece
      // separada da fonte.
      await adapter.templates.create({
        sessionRef: sessao.phoneNumberId,
        draft: {
          name: corpo.name,
          language: corpo.language,
          category: (corpo.category ?? "UTILITY") as "AUTHENTICATION" | "MARKETING" | "UTILITY",
          components: corpo.components,
        },
      });
      await audit({
        action: "template.created",
        organizationId: r.orgId,
        resourceType: "channel_session",
        resourceId: sessao.id,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    // Sincroniza sempre — inclusive depois de criar: a definição nasce em
    // revisão, e o operador precisa VER que ela existe e está pendente.
    const counts = await syncTemplates({
      organizationId: r.orgId,
      wabaId: sessao.wabaId,
      token: creds.token,
      graphVersion: creds.graphVersion,
    });
    return ok(counts);
  } catch (err) {
    // A falha da Graph API vira mensagem legível na tela, não 500 mudo — o
    // operador precisa saber se é token vencido, WABA errada, nome inválido
    // ou rede.
    return fail("internal_error", err instanceof Error ? err.message : "sync_failed", 502, {
      requestId,
    });
  }
}
