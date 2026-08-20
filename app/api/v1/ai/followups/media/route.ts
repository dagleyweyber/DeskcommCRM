/**
 * POST /api/v1/ai/followups/media — upload do arquivo de um nó Ação (mode 'media').
 *
 * Espelha `/api/v1/conversations/[id]/media` (mesmo bucket, mesma validação,
 * mesma transcodificação de nota de voz) — a única diferença é o escopo: o
 * upload de um fluxo não pertence a UMA conversa, o mesmo arquivo é enviado a
 * leads diferentes ao longo do tempo, então o caminho no bucket é da
 * ORGANIZAÇÃO, não de uma conversa específica.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Mesmo papel da tela que hospeda o editor de fluxo (manager+ —
  // app/app/ai/followups/[id]/page.tsx).
  const authz = await requireRole("manager", { requestId, resource: "followup_media" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES + 1_048_576) {
    return fail("payload_too_large", "Arquivo acima de 50MB.", 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const bruto = Buffer.from(await file.arrayBuffer());

  // Mesma razão do upload de conversa: navegador grava nota de voz em webm, e
  // o canal recusa depois de aceitar. Converter aqui garante um arquivo que
  // qualquer canal aceita, e que pode ser reenviado a N leads sem repetir o
  // trabalho a cada disparo do fluxo.
  const audio = await transcodificarNotaDeVoz({ buffer: bruto, mime });
  const mimeFinal = audio.mime;
  const buffer = audio.buffer;

  const storagePath = `${orgId}/followup-media/${randomUUID()}.${extFromMime(mimeFinal)}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mimeFinal, upsert: false });
  if (upErr) {
    console.error("[followups.media] upload failed", upErr.message);
    return fail("internal_error", "Erro ao subir o arquivo.", 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      media_mime: mimeFinal,
      media_size_bytes: buffer.length,
      kind: verdict.kind,
    },
    { requestId },
  );
}
