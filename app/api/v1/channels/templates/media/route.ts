/**
 * A imagem do cabeçalho de um template do CANAL OFICIAL — sobe DIRETO pra
 * Meta (Resumable Upload API) e devolve o HANDLE que a criação de definição
 * exige em `example.header_handle`.
 *
 * ─── Por que uma rota separada da `.../partner/templates/media` ───────────
 *
 * Aquela rota grava no nosso Storage e devolve uma URL assinada — o formato
 * certo pra o que ELA foi desenhada originalmente (mídia de mensagem, que a
 * Cloud API baixa por link no ENVIO). Mas a criação de DEFINIÇÃO pede um
 * objeto totalmente diferente: um handle opaco, obtido subindo o arquivo
 * PARA a Meta antes de submeter o template — ver `resumable-upload.ts`.
 *
 * Duplicar em vez de ramificar a rota antiga: o canal parceiro resolve
 * credencial por um caminho totalmente diferente (sem o App ID que esta
 * rota precisa) — bifurcar por dentro de UMA rota só teria virado um `if`
 * escondendo dois contratos diferentes atrás do mesmo path. Rota nova,
 * contrato explícito; a identidade de qual canal é qual fica onde já mora
 * (`lib/channels/`), não repetida aqui.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import { resolveCreds } from "@/lib/channels/meta/template-ops";
import { uploadMediaHandle } from "@/lib/channels/meta/resumable-upload";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Mesma restrição da rota antiga — só o que a plataforma aceita no cabeçalho. */
const TIPOS = new Set(["image/jpeg", "image/png"]);
const TAMANHO_MAX = 5 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }

  const sessao = await metaSessionForOrg(org.orgId);
  if (!sessao?.phoneNumberId) {
    return fail("invalid_request", "no_meta_channel", 400, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  if (!TIPOS.has(mime)) {
    return fail("unsupported_media_type", "O cabeçalho aceita imagem JPG ou PNG.", 415, { requestId });
  }
  if (file.size > TAMANHO_MAX) {
    return fail("payload_too_large", "A imagem precisa ter até 5 MB.", 413, { requestId });
  }

  let creds;
  try {
    creds = await resolveCreds(sessao.phoneNumberId);
  } catch {
    return fail("invalid_request", "missing_meta_token", 400, { requestId });
  }
  if (!creds.appId) {
    return fail(
      "invalid_request",
      "app_id_ausente: reconecte o canal oficial (Configurações → Conexões → Canal oficial) preenchendo o App ID — necessário pra subir imagem de cabeçalho de template.",
      400,
      { requestId },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const resultado = await uploadMediaHandle({
    appId: creds.appId,
    token: creds.token,
    graphVersion: creds.graphVersion,
    fileName: file.name || `header.${mime === "image/png" ? "png" : "jpg"}`,
    mime,
    bytes,
  });

  if (resultado.status === "failed" || !resultado.handle) {
    logger.error("[channels/templates/media] upload pra Meta falhou", {
      detail: resultado.error,
      requestId,
      organization_id: org.orgId,
    });
    return fail(
      "upstream_unavailable",
      `Não consegui subir a imagem pra Meta: ${resultado.error ?? "motivo desconhecido"}`,
      503,
      { requestId },
    );
  }

  return ok({ handle: resultado.handle }, { requestId });
}
