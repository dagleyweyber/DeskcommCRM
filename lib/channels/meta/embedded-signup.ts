/**
 * Embedded Signup (v4) — o lado SERVIDOR do popup da Meta.
 *
 * O popup entrega ao browser um `code` (vale 30s) e os IDs do que o cliente
 * escolheu. NADA disso é confiável: o browser é do operador, e quem o controla
 * pode mandar o `waba_id` de outra pessoa. Por isso este módulo nunca usa os IDs
 * da tela como verdade — ele troca o code por um token e então PERGUNTA À META a
 * quem o token dá acesso (`debug_token`), e só aceita o par que o token cobre.
 *
 * Fluxo de coexistência (número ainda ativo no app WhatsApp Business do celular):
 *   1. trocar o code pelo token do cliente;
 *   2. conferir que o token alcança a WABA e o número informados;
 *   3. conferir que o número realmente está no app (`is_on_biz_app`);
 *   4. assinar o app à WABA com `override_callback_uri` — a Meta tem UMA URL de
 *      webhook por app, e o CRM roteia por token no caminho de cada sessão;
 *   NÃO registrar o número: ele já está registrado, e `/register` aqui é o que
 *   tira o número do app do celular — o oposto da coexistência.
 *
 * Mora em `lib/channels/meta/` porque a catraca (`lint:channels`) proíbe nomear
 * provider fora de `lib/channels/`.
 */
export type ResultadoEmbedded<T> = ({ ok: true } & T) | { ok: false; motivo: string };

type GraphErro = { error?: { message?: string; error_data?: { details?: string } } };

function versao(v?: string): string {
  return v ?? process.env.META_GRAPH_VERSION ?? "v22.0";
}

function motivoDe(body: GraphErro, status: number): string {
  return body.error?.error_data?.details ?? body.error?.message ?? `http_${status}`;
}

type Opcoes = { graphVersion?: string; fetchImpl?: typeof fetch };

/** Troca o `code` do popup pelo token do cliente. Sem `redirect_uri` (doc da Meta). */
export async function exchangeEmbeddedCode(
  input: { code: string; appId: string; appSecret: string } & Opcoes,
): Promise<ResultadoEmbedded<{ token: string }>> {
  const f = input.fetchImpl ?? fetch;
  const qs = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  });
  try {
    const res = await f(`https://graph.facebook.com/${versao(input.graphVersion)}/oauth/access_token?${qs}`);
    const body = (await res.json().catch(() => ({}))) as GraphErro & { access_token?: string };
    if (!res.ok || body.error || !body.access_token) {
      return { ok: false, motivo: motivoDe(body, res.status) };
    }
    return { ok: true, token: body.access_token };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

/**
 * A quem o token dá acesso, segundo a Meta. `debug_token` com o token de app
 * (`app_id|app_secret`) devolve `granular_scopes[].target_ids`: os IDs de WABA
 * que o cliente autorizou. É a única fonte que o browser não consegue forjar.
 */
export async function wabaIdsDoToken(
  input: { token: string; appId: string; appSecret: string } & Opcoes,
): Promise<ResultadoEmbedded<{ wabaIds: string[]; appIdDoToken: string | null }>> {
  const f = input.fetchImpl ?? fetch;
  const qs = new URLSearchParams({
    input_token: input.token,
    access_token: `${input.appId}|${input.appSecret}`,
  });
  try {
    const res = await f(`https://graph.facebook.com/${versao(input.graphVersion)}/debug_token?${qs}`);
    const body = (await res.json().catch(() => ({}))) as GraphErro & {
      data?: {
        is_valid?: boolean;
        app_id?: string;
        granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
      };
    };
    if (!res.ok || body.error || !body.data?.is_valid) {
      return { ok: false, motivo: motivoDe(body, res.status) };
    }
    const wabaIds = (body.data.granular_scopes ?? [])
      .filter((g) => g.scope === "whatsapp_business_management")
      .flatMap((g) => g.target_ids ?? []);
    return { ok: true, wabaIds, appIdDoToken: body.data.app_id ?? null };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

export interface InfoDoNumero {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  isOnBizApp: boolean;
  platformType: string | null;
}

/** Dados do número + se ele está no app WhatsApp Business (`is_on_biz_app`). */
export async function infoDoNumero(
  input: { phoneNumberId: string; token: string } & Opcoes,
): Promise<ResultadoEmbedded<{ info: InfoDoNumero }>> {
  const f = input.fetchImpl ?? fetch;
  try {
    const res = await f(
      `https://graph.facebook.com/${versao(input.graphVersion)}/${input.phoneNumberId}` +
        `?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`,
      { headers: { Authorization: `Bearer ${input.token}` } },
    );
    const body = (await res.json().catch(() => ({}))) as GraphErro & {
      display_phone_number?: string;
      verified_name?: string;
      is_on_biz_app?: boolean;
      platform_type?: string;
    };
    if (!res.ok || body.error) return { ok: false, motivo: motivoDe(body, res.status) };
    return {
      ok: true,
      info: {
        displayPhoneNumber: body.display_phone_number ?? null,
        verifiedName: body.verified_name ?? null,
        isOnBizApp: body.is_on_biz_app === true,
        platformType: body.platform_type ?? null,
      },
    };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

/**
 * Assina o app à WABA apontando as entregas DESTA WABA para a URL da sessão.
 * `override_callback_uri` tem teto de 200 caracteres (doc da Meta) — a URL com o
 * token do caminho cabe, mas o teste trava para não regredir em silêncio.
 * Template e `account_update` seguem indo à URL padrão do app (doc da Meta).
 */
export async function subscribeWabaComOverride(
  input: { wabaId: string; token: string; callbackUri: string; verifyToken: string } & Opcoes,
): Promise<ResultadoEmbedded<object>> {
  if (input.callbackUri.length > 200) {
    return { ok: false, motivo: "callback_uri_maior_que_200_caracteres" };
  }
  const f = input.fetchImpl ?? fetch;
  try {
    const res = await f(
      `https://graph.facebook.com/${versao(input.graphVersion)}/${input.wabaId}/subscribed_apps`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          override_callback_uri: input.callbackUri,
          verify_token: input.verifyToken,
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as GraphErro & { success?: boolean };
    if (!res.ok || body.error || body.success === false) {
      return { ok: false, motivo: motivoDe(body, res.status) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

/**
 * Números da WABA que estão no app WhatsApp Business. O evento de término da
 * coexistência (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) documenta só o `waba_id`:
 * o número é descoberto aqui, pelo token, em vez de confiar no que o browser mande.
 */
export async function numerosDoAppNaWaba(
  input: { wabaId: string; token: string } & Opcoes,
): Promise<ResultadoEmbedded<{ phoneNumberIds: string[] }>> {
  const f = input.fetchImpl ?? fetch;
  try {
    const res = await f(
      `https://graph.facebook.com/${versao(input.graphVersion)}/${input.wabaId}/phone_numbers` +
        `?fields=id,is_on_biz_app`,
      { headers: { Authorization: `Bearer ${input.token}` } },
    );
    const body = (await res.json().catch(() => ({}))) as GraphErro & {
      data?: Array<{ id?: string; is_on_biz_app?: boolean }>;
    };
    if (!res.ok || body.error) return { ok: false, motivo: motivoDe(body, res.status) };
    const phoneNumberIds = (body.data ?? [])
      .filter((n) => n.is_on_biz_app === true && typeof n.id === "string")
      .map((n) => n.id as string);
    return { ok: true, phoneNumberIds };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

export type TipoDeSincronizacao = "smb_app_state_sync" | "history";

/**
 * Pede à Meta o envio da agenda (`smb_app_state_sync`) ou do histórico (`history`)
 * do app. Cada um vale UMA vez por onboarding e só nas 24h seguintes (doc da Meta):
 * por isso é chamado logo depois de assinar a WABA — e SÓ depois de o recebimento
 * estar de pé, senão a Meta entrega o passado num webhook que ninguém ouve e a
 * janela de pedir de novo nunca mais abre.
 *
 * Resposta de sucesso traz `request_id`; guardado só no log, para suporte.
 */
export async function pedirSincronizacao(
  input: { phoneNumberId: string; token: string; tipo: TipoDeSincronizacao } & Opcoes,
): Promise<ResultadoEmbedded<{ requestId: string | null }>> {
  const f = input.fetchImpl ?? fetch;
  try {
    const res = await f(
      `https://graph.facebook.com/${versao(input.graphVersion)}/${input.phoneNumberId}/smb_app_data`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", sync_type: input.tipo }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as GraphErro & { request_id?: string };
    if (!res.ok || body.error) return { ok: false, motivo: motivoDe(body, res.status) };
    return { ok: true, requestId: body.request_id ?? null };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}
