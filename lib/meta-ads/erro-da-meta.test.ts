import { describe, expect, it } from "vitest";

import { interpretaErroDaMeta } from "./erro-da-meta";

/** Corpos reais gravados em produção (meta_capi_send_log, outubro de 2026), sem o fbtrace_id. */
const REAIS = {
  semPagina:
    'http_400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2804131,"is_transient":false,"error_user_title":"Evento de mensagem nenhuma Página associada ao conjunto de dados","error_user_msg":"Para eventos de CTM e CTWA, a identificação do conjunto de dados é usada para enviar eventos à API de Conversões e deve ter uma Página associada"}}',
  leadInvalido:
    'http_400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2804066,"is_transient":false,"error_user_title":"Evento de mensagem com tipo de evento inválido","error_user_msg":"O valor do parâmetro de nome do evento \'Lead\' fornecido para seus eventos com a fonte da ação business_messaging é inválido."}}',
  semPaginaOuWaba:
    'http_400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2804116,"is_transient":false,"error_user_title":"Falta a identificação da Página ou da conta do WhatsApp Business"}}',
};

describe("interpretaErroDaMeta", () => {
  it("⭐ 2804131 (conjunto de dados sem Página): configuração, definitivo, com instrução em português", () => {
    const e = interpretaErroDaMeta(REAIS.semPagina);
    expect(e).toMatchObject({ subcode: "2804131", transitorio: false, deConfiguracao: true });
    expect(e.oQueFazer).toMatch(/associe este conjunto de dados à Página/);
  });

  it("⭐ 2804066 ('Lead' em conversa de WhatsApp): definitivo, com instrução", () => {
    const e = interpretaErroDaMeta(REAIS.leadInvalido);
    expect(e).toMatchObject({ subcode: "2804066", transitorio: false });
    expect(e.oQueFazer).toBeTruthy();
  });

  it("2804116 (sem Página/WABA): manda conectar a leitura de anúncio", () => {
    expect(interpretaErroDaMeta(REAIS.semPaginaOuWaba).oQueFazer).toMatch(/Leitura de campanha e anúncio/);
  });

  it("⭐ token expirado (code 190): configuração, manda reconectar", () => {
    const e = interpretaErroDaMeta('http_400: {"error":{"message":"Error validating access token","code":190}}');
    expect(e).toMatchObject({ transitorio: false, deConfiguracao: true });
    expect(e.oQueFazer).toMatch(/conecte o Meta Ads de novo/);
  });

  it("⭐ erro sem corpo da Meta (rede, timeout, 5xx) continua TRANSITÓRIO — reenviar pode resolver", () => {
    expect(interpretaErroDaMeta("The operation was aborted due to timeout").transitorio).toBe(true);
    expect(interpretaErroDaMeta("http_502: Bad Gateway").transitorio).toBe(true);
    expect(interpretaErroDaMeta(null).transitorio).toBe(true);
  });

  it("subcode desconhecido usa o título da própria Meta e respeita is_transient", () => {
    const e = interpretaErroDaMeta(
      'http_400: {"error":{"message":"x","error_subcode":9999,"is_transient":true,"error_user_title":"Algo novo"}}',
    );
    expect(e).toMatchObject({ subcode: "9999", transitorio: true, deConfiguracao: false, motivo: "Algo novo", oQueFazer: null });
  });

  it("⭐ corpo CORTADO (JSON inválido) ainda é lido: subcode e is_transient vêm do começo", () => {
    // Exatamente o que o painel mostrava cru em produção (RevitaFio Mossoró, 2026-10-28).
    const e = interpretaErroDaMeta(
      'http_400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2804131,"is_transient":false,"error_user_title":"Evento de mensagem nenhuma P\\u00e1gina associada a',
    );
    expect(e).toMatchObject({ subcode: "2804131", transitorio: false, deConfiguracao: true });
    expect(e.oQueFazer).toMatch(/associe este conjunto de dados/);
  });

  it("corpo cortado com token expirado (code 190) é reconhecido", () => {
    const e = interpretaErroDaMeta('http_401: {"error":{"message":"Error validating access token","code":190,"err');
    expect(e.motivo).toMatch(/token/);
  });
});
