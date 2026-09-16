"use client";
import type { Message } from "@/lib/types/messaging";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { StickerMedia } from "./StickerMedia";
import { VideoMedia } from "./VideoMedia";

/**
 * Dispatcher de mídia por message.type (Onda 1). Tipo com mídia mas sem
 * renderer dedicado (location/contact futuros) cai no DocumentCard —
 * sempre dá pro atendente baixar o arquivo.
 *
 * `template` é o único tipo com mídia que não é UM formato fixo: o mesmo
 * `type: "template"` serve pra cabeçalho de imagem, vídeo ou documento (ou
 * nenhum). `message.type` continua "template" de propósito — cost/janela de
 * conformidade contam com isso em outro lugar —, então aqui o desempate é
 * pelo `media_mime` gravado no envio (ver `lib/messaging/header-media-storage.ts`).
 */
/** Extraída pura pra testar sem montar o componente inteiro. */
export function tipoEfetivoDeMidia(message: Pick<Message, "type" | "media_mime">): string {
  if (message.type !== "template" || !message.media_mime) return message.type;
  if (message.media_mime.startsWith("image/")) return "image";
  if (message.media_mime.startsWith("video/")) return "video";
  return "document";
}

export function MediaRenderer({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  switch (tipoEfetivoDeMidia(message)) {
    case "image":
      return <ImageMedia messageId={message.id} alt="Imagem recebida" />;
    case "sticker":
      return <StickerMedia messageId={message.id} />;
    case "audio":
      return <AudioPlayer messageId={message.id} isOutbound={isOutbound} />;
    case "video":
      return <VideoMedia messageId={message.id} />;
    default:
      return (
        <DocumentCard
          messageId={message.id}
          mime={message.media_mime}
          sizeBytes={message.media_size_bytes}
          storagePath={message.media_storage_path}
          isOutbound={isOutbound}
        />
      );
  }
}
