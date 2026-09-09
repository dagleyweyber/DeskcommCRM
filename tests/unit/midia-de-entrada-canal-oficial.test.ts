import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O MESMO defeito de três elos que `midia-de-entrada-por-canal.test.ts` já
 * trava pro canal intermediado — achado ao vivo no canal OFICIAL (RevitaFio
 * Mossoró), que nunca ganhou o conserto quando o outro canal ganhou.
 *
 * Medido em produção antes deste conserto: 4 mensagens de mídia recebidas
 * (áudio, imagem, 2 documentos), as 4 com `status:'delivered'` e
 * `media_storage_path` VAZIO — a linha existe, o atendente vê "áudio" ou
 * "documento" na lista, e não tem nada pra tocar/abrir.
 *
 *   elo 1: `media_url` nunca gravado (só `metadata.meta_media_id`) — o
 *          worker sai com "no media_url" antes de tentar.
 *   elo 2: `media.persist_requested` nunca emitido — ninguém acorda o worker.
 *   elo 3: o adapter nunca implementou `fetchInboundMedia` — mesmo acordado
 *          e com URL, não tinha quem soubesse baixar.
 *
 * A Cloud API é a ÚNICA que baixa em DOIS passos (o `id` do webhook não é
 * uma URL — precisa resolver pra uma antes), por isso o elo 1 aqui grava o
 * `media_id`, não uma URL de verdade — o comentário do próprio tipo já diz
 * "cada canal sabe o que fazer com ela".
 */

const INGEST = readFileSync("lib/channels/meta/ingest.ts", "utf8");
const ADAPTER = readFileSync("lib/channels/adapters/meta-cloud.ts", "utf8");

describe("elo 1 — o media_id é gravado onde o worker procura media_url", () => {
  it("grava media_url com o id do anexo (a Cloud API não manda URL no webhook)", () => {
    expect(INGEST).toMatch(/media_url: e\.media\?\.id \?\? null/);
  });
});

describe("elo 2 — alguém acorda o worker", () => {
  it("emite `media.persist_requested`", () => {
    expect(INGEST).toMatch(/p_event_type: "media\.persist_requested"/);
  });

  it("com o MESMO payload dos outros canais — o consumidor é um só", () => {
    expect(INGEST).toMatch(
      /p_payload: \{ message_id: messageId, conversation_id: conversationId \}/,
    );
  });

  it("só quando a mensagem TEM mídia — texto não acorda o worker à toa", () => {
    expect(INGEST).toMatch(/if \(messageId && e\.media\)/);
  });

  it("falha do emit NÃO derruba a ingestão", () => {
    expect(INGEST).toMatch(/logger\.warn\("\[meta\.ingest\] emit media\.persist_requested falhou"/);
  });
});

describe("elo 3 — o adapter da Meta agora sabe baixar", () => {
  it("implementa `fetchInboundMedia`", () => {
    expect(ADAPTER).toMatch(/async fetchInboundMedia\(input: \{/);
  });

  it("resolve credencial pela SESSÃO — mesmo padrão do resto do canal", () => {
    expect(ADAPTER).toMatch(/resolveMetaCreds\(createAdminClient\(\), input\.sessionRef\)/);
  });

  it("⭐ baixa em DOIS passos — resolve o media_id pra URL antes de buscar os bytes", () => {
    // A Cloud API não devolve link pronto no webhook; sem o passo de lookup
    // (`GET /{media-id}`), a URL que o worker tenta buscar é o ID cru, e a
    // Graph API devolve 404 pra qualquer id que não seja uma URL válida.
    expect(ADAPTER).toMatch(/graph\.facebook\.com\/\$\{creds\.graphVersion\}\/\$\{mediaId\}/);
    expect(ADAPTER).toMatch(/fetch\(lookupBody\.url,/);
  });

  it("o MESMO Bearer token vai nas duas chamadas — a Meta exige nas duas", () => {
    const chamadas = [...ADAPTER.matchAll(/Authorization: `Bearer \$\{creds\.token\}`/g)];
    expect(chamadas.length).toBeGreaterThanOrEqual(2);
  });

  it("aplica a mesma defesa de SSRF que o canal intermediado — não confia cegamente na URL", () => {
    expect(ADAPTER).toMatch(/assertSafeOutboundUrl\(lookupBody\.url\)/);
    expect(ADAPTER).toMatch(/assertDestinoResolvidoSeguro\(new URL\(lookupBody\.url\)\.hostname\)/);
  });

  it("o content-type da resposta manda sobre a dica do webhook", () => {
    expect(ADAPTER).toMatch(/res\.headers\.get\("content-type"\)/);
  });
});
