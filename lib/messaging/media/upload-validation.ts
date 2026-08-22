/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Posse do objeto no bucket `whatsapp-media`: o path deve estar sob um dos
 * DOIS prefixos legítimos da org — chaves do Storage são literais, sem
 * semântica de traversal, então a fronteira de segurança real é a
 * ORGANIZAÇÃO, não a conversa.
 *
 *  - `{org}/{conversation}/…` — upload feito DURANTE uma conversa (composer
 *    do Inbox, `app/api/v1/conversations/[id]/media/route.ts`).
 *  - `{org}/followup-media/…` — upload feito na TELA DO FLUXO, antes de
 *    existir qualquer conversa (`app/api/v1/ai/followups/media/route.ts`):
 *    o mesmo arquivo é reenviado a leads/conversas DIFERENTES a cada
 *    matrícula, então não pode nascer preso a UMA conversa. Sem este
 *    segundo prefixo, todo nó Ação (mode 'media') falhava 100% das vezes —
 *    medido em produção, `send_media` sempre com "media_storage_path fora
 *    da conversa", em qualquer lead.
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  return path.startsWith(`${orgId}/${conversationId}/`) || path.startsWith(`${orgId}/followup-media/`);
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
