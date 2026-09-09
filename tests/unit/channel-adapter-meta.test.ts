import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";

/**
 * O adapter resolve a credencial POR SESSÃO (banco) com o env como fallback. Sem
 * mockar o admin client, o `fetch` stubado captura a query do Supabase em vez da
 * chamada à Graph API — foi assim que estes testes vermelharam quando a resolução
 * por sessão entrou, e o vermelho foi correto.
 */
const sessaoNoBanco: { token: string | null } = { token: null };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: sessaoNoBanco.token
              ? { meta_phone_number_id: "sessao-pn", meta_token_encrypted: "\\xdeadbeef" }
              : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: sessaoNoBanco.token, error: null }),
  }),
}));

const a = () => getAdapter("meta_cloud");

function configurar() {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  vi.stubEnv("META_GRAPH_VERSION", "v22.0");
}

function stubFetch(resposta: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => resposta,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessaoNoBanco.token = null;
});

describe("adapter meta_cloud — endereçamento", () => {
  it("telefone vira E.164 em DÍGITOS, sem + e sem sufixo", () => {
    // `@c.us` é do outro canal. Um `+` sobrevivente vira (#131009) na Meta.
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: "+55 (31) 99896-6398", waIdentity: null,
    })).toBe("5531998966398");
  });

  it("grupo devolve null — a API de grupos não faz parte deste seam", () => {
    expect(a().resolveRecipient({
      isGroup: true, groupChatId: "123@g.us", phoneNumber: "+5531999998888", waIdentity: null,
    })).toBeNull();
  });

  it("sem telefone devolve null — não há `lid` neste canal", () => {
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: "lid:12345",
    })).toBeNull();
  });
});

describe("adapter meta_cloud — configuração", () => {
  it("isConfigured é SEMPRE true — a credencial vive na sessão, e isto é síncrono", () => {
    // Achado ao vivo (RevitaFio Mossoró): olhar só o env respondia "não
    // configurado" para toda instalação que conectou pela tela, e o handler
    // gravava `queued` sem nunca chamar `send`. A mensagem ficava parada, sem
    // erro, com o canal ligado e o webhook recebendo mensagem normalmente.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    expect(a().isConfigured()).toBe(true);
    configurar();
    expect(a().isConfigured()).toBe(true);
  });

  it("sem credencial (nem sessão, nem env) o envio LANÇA — nunca `sent` sem id", async () => {
    // `{externalId: null}` faria o handler gravar `status:'sent'` sem id,
    // dizendo "enviado" para algo que nunca saiu. Quem desiste agora é `send`.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    await expect(
      a().send({ sessionRef: "sem-sessao-nem-env", to: "5531999", kind: "text", body: "oi" }),
    ).rejects.toThrow(/meta_not_configured/);
  });

  it("os códigos carregam o nome do provider — por isso vivem no adapter", () => {
    expect(a().codes.notConfigured).toContain("meta");
    expect(a().codes.sendFailed).toContain("meta");
  });
});

describe("adapter meta_cloud — envio", () => {
  it("texto vai como type:text e o phone_number_id entra na URL, não no corpo", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.T" }] });
    const r = await a().send({ sessionRef: "ignorado", to: "5531998966398", kind: "text", body: "oi" });

    expect(r).toEqual({ externalId: "wamid.T" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/v22.0/1103328999528818/messages");
    const corpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(corpo).toMatchObject({ messaging_product: "whatsapp", to: "5531998966398", type: "text" });
    expect(corpo).not.toHaveProperty("session");
  });

  it("áudio leva voice:true — sem isso vira anexo de música, não nota de voz", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.A" }] });
    await a().send({
      sessionRef: "x", to: "5531998966398", kind: "audio",
      media: { url: "https://x/a.ogg", mime: "audio/ogg" },
    });
    const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      type: string; audio: { link: string; voice: boolean };
    };
    expect(corpo.type).toBe("audio");
    expect(corpo.audio.voice).toBe(true);
  });

  it("imagem leva caption; documento leva filename", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.I" }] });
    await a().send({
      sessionRef: "x", to: "5531", kind: "image",
      media: { url: "https://x/a.jpg", mime: "image/jpeg", caption: "olha" },
    });
    expect(JSON.parse(spy.mock.calls[0]![1].body as string).image).toEqual({
      link: "https://x/a.jpg", caption: "olha",
    });

    const spy2 = stubFetch({ messages: [{ id: "wamid.D" }] });
    await a().send({
      sessionRef: "x", to: "5531", kind: "document",
      media: { url: "https://x/a.pdf", mime: "application/pdf", filename: "contrato.pdf" },
    });
    expect(JSON.parse(spy2.mock.calls[0]![1].body as string).document).toMatchObject({
      filename: "contrato.pdf",
    });
  });

  it("erro da Meta lança com o `details`, que diz QUAL parâmetro divergiu", async () => {
    configurar();
    stubFetch(
      {
        error: {
          code: 131009,
          message: "Parameter value is not valid",
          error_data: { details: "to: número em formato inválido" },
        },
      },
      false,
    );
    await expect(
      a().send({ sessionRef: "x", to: "+5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/131009.*formato inválido/);
  });

  it("resposta sem id devolve externalId null, sem estourar", async () => {
    configurar();
    stubFetch({ messages: [] });
    const r = await a().send({ sessionRef: "x", to: "5531", kind: "text", body: "oi" });
    expect(r).toEqual({ externalId: null });
  });
});

describe("credencial por sessão — o que destrava multi-tenant", () => {
  it("com token na SESSÃO, o env deixa de valer", async () => {
    // Ordem sessão-primeiro: um env esquecido não pode silenciar o que foi
    // configurado pela tela, senão o operador não entende por que nada mudou.
    configurar();
    sessaoNoBanco.token = "token-da-sessao";
    const spy = stubFetch({ messages: [{ id: "wamid.S" }] });

    await a().send({ sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("sem token na sessão, cai no env — instalação de número único segue funcionando", async () => {
    configurar();
    sessaoNoBanco.token = null;
    const spy = stubFetch({ messages: [{ id: "wamid.E" }] });

    await a().send({ sessionRef: "qualquer", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

/**
 * BAIXAR MÍDIA RECEBIDA — a metade que faltava desde que o canal existe.
 *
 * Achado ao vivo (RevitaFio Mossoró): áudio/imagem/documento chegavam,
 * viravam linha em `messages`, e nunca ganhavam bytes — o adapter não tinha
 * `fetchInboundMedia`. Diferente do canal intermediado (URL pronta no
 * payload), a Cloud API só manda um `id`: é preciso resolver esse `id` pra
 * uma URL assinada (`GET /{media-id}`) ANTES de buscar os bytes — dois
 * fetches, não um, e o MESMO Bearer nos dois (a segunda chamada também
 * exige, mesmo batendo no CDN da Meta).
 */
describe("adapter meta_cloud — baixar mídia recebida (dois passos)", () => {
  it("resolve o media_id pra URL, depois baixa os bytes — Bearer nas duas chamadas", async () => {
    configurar();
    const chamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        chamadas.push(url);
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
        if (url.includes("graph.facebook.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: "https://scontent.xx.fbcdn.net/media/abc123", mime_type: "audio/ogg" }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "audio/ogg" }),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }),
    );

    const r = await a().fetchInboundMedia!({ sessionRef: "1103328999528818", url: "meta-media-id-123" });

    expect(chamadas[0]).toContain("/v22.0/meta-media-id-123");
    expect(chamadas[1]).toBe("https://scontent.xx.fbcdn.net/media/abc123");
    expect(r.mime).toBe("audio/ogg");
    expect(Buffer.from(r.buffer)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("id vencido/inválido: o lookup falha e NUNCA chega a tentar baixar", async () => {
    // A Meta descarta o media_id depois de um tempo — 400/404 aqui é normal
    // pra mídia velha, não uma falha de rede pra tentar de novo.
    configurar();
    const spy = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "Unsupported get request." } }),
    }));
    vi.stubGlobal("fetch", spy);

    await expect(
      a().fetchInboundMedia!({ sessionRef: "1103328999528818", url: "id-expirado" }),
    ).rejects.toThrow(/meta_media_lookup_failed/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("URL de download maliciosa (SSRF) é recusada ANTES de sair a credencial", async () => {
    // A URL do 2º passo vem da RESPOSTA da Meta, não do payload do webhook —
    // mais confiável que o canal intermediado, mas a defesa em profundidade
    // não deveria depender de qual provider está do outro lado.
    configurar();
    const spy = vi.fn(async (url: string) => {
      if (url.includes("graph.facebook.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "http://169.254.169.254/latest/meta-data/", mime_type: "audio/ogg" }),
        };
      }
      throw new Error("não deveria chegar aqui");
    });
    vi.stubGlobal("fetch", spy);

    await expect(
      a().fetchInboundMedia!({ sessionRef: "1103328999528818", url: "meta-media-id-123" }),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
