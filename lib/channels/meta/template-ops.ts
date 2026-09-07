/**
 * Gestão de definições aprovadas do canal OFICIAL — criar, editar, apagar,
 * listar. A metade que faltava, exatamente como o comentário de
 * `lib/channels/zernio/templates.ts` previa: "o canal oficial pode ganhar a
 * mesma coisa sem uma segunda interface" — `ChannelTemplateOps` é a mesma.
 *
 * Achado ao vivo (RevitaFio Mossoró): a criação de modelo era só possível pelo
 * Gerenciador do WhatsApp da Meta — o CRM só ESPELHAVA (`template-sync.ts`).
 * O usuário pediu a peça que faltava.
 *
 * ─── `sessionRef` é o `phone_number_id`, mas o endpoint pede a WABA ────────
 *
 * Como todo o resto do adapter (`meta-cloud.ts`), `sessionRef` é o
 * `phone_number_id`. O endpoint de definições, porém, é por WABA
 * (`/{waba_id}/message_templates`) — por isso o resolvedor busca as DUAS
 * colunas juntas, em vez de reaproveitar `resolveMetaCreds`
 * (`../meta/credentials.ts`), que só devolve `phoneNumberId`.
 *
 * ─── Sessão primeiro, env como fallback — mesmo padrão do resto do canal ───
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import type { ChannelTemplate, ChannelTemplateDraft, ChannelTemplateOps } from "../types";

interface WabaCreds {
  wabaId: string;
  token: string;
  graphVersion: string;
}

function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v22.0";
}

async function credsFromSession(
  admin: SupabaseClient,
  phoneNumberId: string,
): Promise<WabaCreds | null> {
  if (!phoneNumberId) return null;
  const { data } = await admin
    .from("channel_sessions")
    .select("meta_waba_id, meta_token_encrypted")
    .eq("meta_phone_number_id", phoneNumberId)
    .maybeSingle();

  const wabaId = data?.meta_waba_id as string | undefined;
  const cifrado = data?.meta_token_encrypted;
  if (!data || !wabaId || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  if (!token) return null;

  return { wabaId, token, graphVersion: graphVersion() };
}

function credsFromEnv(): WabaCreds | null {
  const wabaId = process.env.META_WABA_ID;
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!wabaId || !token) return null;
  return { wabaId, token, graphVersion: graphVersion() };
}

async function resolveCreds(sessionRef: string): Promise<WabaCreds> {
  const admin = createAdminClient();
  const creds = (await credsFromSession(admin, sessionRef)) ?? credsFromEnv();
  if (!creds) {
    throw new Error("meta_not_configured: nenhuma credencial para esta conta (nem na sessão, nem no ambiente).");
  }
  return creds;
}

interface RawTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string | null;
  components?: unknown[];
  rejected_reason?: string | null;
  parameter_format?: string | null;
}

function toNeutral(t: RawTemplate): ChannelTemplate {
  return {
    name: t.name ?? "",
    language: t.language ?? "",
    status: t.status ?? "UNKNOWN",
    category: t.category ?? null,
    components: Array.isArray(t.components) ? t.components : [],
    rejectedReason: t.rejected_reason ?? null,
    parameterFormat: t.parameter_format ?? null,
  };
}

const FIELDS = "id,name,language,status,category,parameter_format,rejected_reason,components";

/**
 * A chamada com o erro da Graph API preservado — `error_data.details` é o
 * que distingue "nome já usado" de "categoria inválida" de "faltou exemplo",
 * e sem ele a tela mostra só "falhou".
 */
async function call<T>(
  creds: WabaCreds,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(`https://graph.facebook.com/${creds.graphVersion}${path}${qs}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const json = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: { message?: string; error_data?: { details?: string } } })
    | null;

  if (!res.ok || json?.error) {
    const detalhe = json?.error?.error_data?.details ?? json?.error?.message ?? res.statusText;
    throw new Error(`meta_template_failed: ${res.status} ${detalhe}`.trim());
  }
  return json as T;
}

export const metaTemplateOps: ChannelTemplateOps = {
  async list({ sessionRef }): Promise<ChannelTemplate[]> {
    const creds = await resolveCreds(sessionRef);
    const j = await call<{ data?: RawTemplate[] }>(creds, `/${creds.wabaId}/message_templates`, {
      method: "GET",
      query: { fields: FIELDS, limit: "100" },
    });
    return (j.data ?? []).map(toNeutral);
  },

  async create({ sessionRef, draft }): Promise<ChannelTemplate> {
    const creds = await resolveCreds(sessionRef);
    // O formato do nome (`^[a-z][a-z0-9_]*$`) e o conteúdo são validados PELA
    // PLATAFORMA — a recusa vem com `error_data.details`, e duplicar a regra
    // aqui a faria envelhecer separada da fonte.
    const j = await call<RawTemplate>(creds, `/${creds.wabaId}/message_templates`, {
      method: "POST",
      body: {
        name: draft.name,
        category: draft.category,
        language: draft.language,
        components: draft.components,
        ...(draft.parameterFormat ? { parameter_format: draft.parameterFormat } : {}),
      },
    });
    // O POST de criação devolve só `{id, status, category}` — sem name/language
    // de volta. O rascunho já tem os dois; `list()` (chamado pela rota logo
    // depois) é quem traz o espelho completo.
    return toNeutral({ ...j, name: draft.name, language: draft.language });
  },

  /**
   * Meta identifica a definição por ID nesta chamada, não por nome — diferente
   * de `create`/`remove`, que usam nome. Por isso resolve o ID via `list`
   * antes de editar; não há atalho direto por nome neste endpoint.
   */
  async update({ sessionRef, name, patch }): Promise<ChannelTemplate> {
    const creds = await resolveCreds(sessionRef);
    const encontrados = await call<{ data?: RawTemplate[] }>(
      creds,
      `/${creds.wabaId}/message_templates`,
      { method: "GET", query: { fields: FIELDS, name } },
    );
    const alvo = (encontrados.data ?? [])[0];
    if (!alvo?.id) {
      throw new Error(`meta_template_failed: template "${name}" não encontrado para editar.`);
    }

    await call<{ success?: boolean }>(creds, `/${alvo.id}`, {
      method: "POST",
      body: {
        ...(patch.components ? { components: patch.components } : {}),
        ...(patch.category ? { category: patch.category } : {}),
      },
    });

    return toNeutral({ ...alvo, ...patch });
  },

  async remove({ sessionRef, name, language }): Promise<void> {
    const creds = await resolveCreds(sessionRef);
    await call<unknown>(creds, `/${creds.wabaId}/message_templates`, {
      method: "DELETE",
      query: { name, ...(language ? { language } : {}) },
    });
  },
};

export type { ChannelTemplate, ChannelTemplateDraft };
