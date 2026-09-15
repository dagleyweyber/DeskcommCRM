/**
 * Resumable Upload API da Meta — o único jeito de conseguir um HANDLE de
 * mídia aceito em `components[].example.header_handle` na criação de um
 * template com cabeçalho de IMAGEM (ou VIDEO/DOCUMENT).
 *
 * ─── Por que isto existe: o bug que motivou ────────────────────────────────
 *
 * Achado ao vivo (RevitaFio Mossoró): `template-conteudo.ts` mandava uma URL
 * assinada do nosso Storage em `header_handle`, comentando "a plataforma
 * baixa o arquivo na revisão" — falso. Esse download-por-URL é o contrato de
 * ENVIO de mensagem (Cloud API, `type: image, image: {link}`), um endpoint
 * diferente com regras diferentes. Na CRIAÇÃO de definição, o campo pede um
 * HANDLE opaco (ex.: `4:nome.jpg:image/jpeg:ARa...`), que só existe depois
 * de subir o arquivo PARA A META por este fluxo de dois passos. Mandar URL
 * ali sempre dá "Parâmetro de exemplo não fornecido" — não importa a URL.
 *
 * ─── Os dois passos ─────────────────────────────────────────────────────────
 *
 * 1. `POST /{app_id}/uploads?file_name=&file_length=&file_type=` — abre uma
 *    sessão de upload. Devolve `id` no formato `upload:<sessao>`.
 * 2. `POST /{sessao}` (o `id` do passo 1, JÁ com o prefixo `upload:`) com o
 *    header `file_offset: 0` e o corpo sendo os BYTES crus do arquivo (não
 *    multipart, não base64). Devolve `{h: "<handle>"}`.
 *
 * As duas chamadas usam `Authorization: OAuth <token>` (não `Bearer`) — é o
 * esquema que a documentação da Resumable Upload API pede, diferente do
 * resto da Graph API neste repo.
 */
const GRAPH_API_VERSION_DEFAULT = "v22.0";
const TIMEOUT_MS = 20_000;

export interface UploadMediaHandleInput {
  appId: string;
  token: string;
  graphVersion?: string;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}

export interface UploadMediaHandleResult {
  status: "ok" | "failed";
  handle?: string;
  error?: string;
}

interface UploadSessionResponse {
  id?: string;
  error?: { message?: string };
}
interface UploadFinishResponse {
  h?: string;
  error?: { message?: string };
}

export async function uploadMediaHandle(
  input: UploadMediaHandleInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<UploadMediaHandleResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const version = input.graphVersion ?? GRAPH_API_VERSION_DEFAULT;

  try {
    const qs = new URLSearchParams({
      file_name: input.fileName,
      file_length: String(input.bytes.byteLength),
      file_type: input.mime,
    });
    const sessaoRes = await fetchFn(
      `https://graph.facebook.com/${version}/${encodeURIComponent(input.appId)}/uploads?${qs}`,
      {
        method: "POST",
        headers: { Authorization: `OAuth ${input.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const sessaoTexto = await sessaoRes.text().catch(() => "");
    let sessaoJson: UploadSessionResponse | null = null;
    try {
      sessaoJson = JSON.parse(sessaoTexto) as UploadSessionResponse;
    } catch {
      sessaoJson = null;
    }
    if (!sessaoRes.ok || !sessaoJson?.id) {
      const msg = sessaoJson?.error?.message ?? sessaoTexto;
      return { status: "failed", error: `sessao http_${sessaoRes.status}: ${msg.slice(0, 300)}` };
    }

    const finalizaRes = await fetchFn(`https://graph.facebook.com/${version}/${sessaoJson.id}`, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${input.token}`,
        file_offset: "0",
        "Content-Type": "application/octet-stream",
      },
      body: input.bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const finalizaTexto = await finalizaRes.text().catch(() => "");
    let finalizaJson: UploadFinishResponse | null = null;
    try {
      finalizaJson = JSON.parse(finalizaTexto) as UploadFinishResponse;
    } catch {
      finalizaJson = null;
    }
    if (!finalizaRes.ok || !finalizaJson?.h) {
      const msg = finalizaJson?.error?.message ?? finalizaTexto;
      return { status: "failed", error: `upload http_${finalizaRes.status}: ${msg.slice(0, 300)}` };
    }

    return { status: "ok", handle: finalizaJson.h };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
