/**
 * `HeaderMedia` (a mídia de cabeçalho de um template que acabou de sair) →
 * o que a linha de `messages` precisa pra guardar e a conversa no inbox
 * mostrar de volta.
 *
 * Achado ao vivo (RevitaFio Mossoró): o envio de campanha com cabeçalho de
 * imagem funcionava certo — a Meta aceitava, devolvia `wamid` — mas a
 * mensagem gravada em `messages` nunca guardava a mídia usada, só o texto.
 * O operador via "enviado" e nenhuma imagem, sem jeito de saber se o envio
 * realmente levou o cabeçalho ou não.
 *
 * A URL usada no envio é (quase sempre) uma signed URL do NOSSO bucket
 * `whatsapp-media` — de onde vem o botão "Subir imagem" do picker de
 * campanha/automação. Quando é, extrai o PATH de dentro dela e devolve como
 * `media_storage_path`: a mesma coluna que toda mídia de conversa já usa,
 * servida por `/api/v1/messages/[id]/media` (signed URL fresca, TTL 1h) —
 * não `media_url`, que naquela rota tem outro sentido (mídia de ENTRADA
 * ainda não copiada do provider, ver o cabeçalho do route.ts). Quando a URL
 * não é do nosso bucket (ex.: vídeo/documento colado por link externo, o
 * caminho que a tela ainda oferece fora de imagem), não há path pra
 * extrair — a mensagem fica sem mídia gravada, do jeito que já era antes
 * deste fix, em vez de arriscar guardar algo que a rota de mídia não sabe
 * servir.
 */
import type { HeaderMedia } from "@/lib/channels/meta/build-components";

const BUCKET = "whatsapp-media";
const SIGNED_URL_MARKER = `/storage/v1/object/sign/${BUCKET}/`;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  pdf: "application/pdf",
};

const GENERIC_MIME: Record<HeaderMedia["kind"], string> = {
  image: "image/jpeg",
  video: "video/mp4",
  document: "application/pdf",
};

/** Extensão do path > mapa fixo por tipo de slot — nunca adivinha do zero. */
function mimeFor(kind: HeaderMedia["kind"], path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && EXT_MIME[ext]) || GENERIC_MIME[kind];
}

export interface ResolvedHeaderMediaStorage {
  storagePath: string;
  mime: string;
}

/**
 * `null` quando a URL não é uma signed URL do nosso bucket `whatsapp-media`
 * — nesse caso não há o que gravar, e quem chama simplesmente não passa
 * `media_storage_path`/`media_mime` no update da mensagem.
 */
export function resolveHeaderMediaStorage(media: HeaderMedia): ResolvedHeaderMediaStorage | null {
  const i = media.url.indexOf(SIGNED_URL_MARKER);
  if (i === -1) return null;
  const resto = media.url.slice(i + SIGNED_URL_MARKER.length);
  const storagePath = resto.split("?")[0];
  if (!storagePath) return null;
  return { storagePath, mime: mimeFor(media.kind, storagePath) };
}
