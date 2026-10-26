/**
 * Lado BROWSER do Embedded Signup (v4): abre o popup, escuta o `postMessage` da
 * Meta e devolve `{ code, wabaId, phoneNumberId }`.
 *
 * Duas fontes chegam em momentos diferentes e nenhuma basta sozinha: o callback do
 * `FB.login` traz o `code` (vale 30s) e o `postMessage` traz os IDs escolhidos. Só
 * resolvemos quando as DUAS chegaram.
 *
 * Nada aqui é confiança: o servidor revalida tudo com a Meta (ver
 * `embedded-signup.ts`). O que este arquivo faz é a parte que a Meta exige do
 * cliente — inclusive checar `event.origin`, que é o que impede outra aba de
 * injetar IDs na nossa sessão.
 */
const SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const GRAPH_SDK_VERSION = "v26.0";

type FbSdk = {
  init: (o: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

export type ResultadoPopup =
  | { ok: true; code: string; wabaId: string; phoneNumberId: string | null }
  | { ok: false; motivo: "cancelado" | "erro"; detalhe?: string };

let sdkPronto: Promise<FbSdk> | null = null;

function carregarSdk(appId: string): Promise<FbSdk> {
  if (sdkPronto) return sdkPronto;
  sdkPronto = new Promise<FbSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("sdk_indisponivel"));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_SDK_VERSION });
      resolve(window.FB);
    };
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdkPronto = null; // permite nova tentativa (rede/bloqueador)
      reject(new Error("sdk_bloqueado"));
    };
    document.body.appendChild(s);
  });
  return sdkPronto;
}

/** `event.origin` da Meta termina em `facebook.com` (doc do Embedded Signup). */
export function origemDaMeta(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

export async function abrirEmbeddedSignup(cfg: { appId: string; configId: string }): Promise<ResultadoPopup> {
  let fb: FbSdk;
  try {
    fb = await carregarSdk(cfg.appId);
  } catch (e) {
    return { ok: false, motivo: "erro", detalhe: e instanceof Error ? e.message : "sdk" };
  }

  return new Promise<ResultadoPopup>((resolve) => {
    let code: string | null = null;
    let ids: { wabaId: string; phoneNumberId: string | null } | null = null;
    let fim = false;

    const encerrar = (r: ResultadoPopup) => {
      if (fim) return;
      fim = true;
      window.removeEventListener("message", ouvir);
      resolve(r);
    };
    const tentar = () => {
      if (code && ids) encerrar({ ok: true, code, ...ids });
    };

    function ouvir(ev: MessageEvent) {
      if (!origemDaMeta(ev.origin)) return;
      let dado: unknown = ev.data;
      if (typeof dado === "string") {
        try {
          dado = JSON.parse(dado);
        } catch {
          return;
        }
      }
      const d = dado as { type?: string; event?: string; data?: Record<string, unknown> } | null;
      if (!d || d.type !== "WA_EMBEDDED_SIGNUP") return;

      if (d.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || d.event === "FINISH") {
        const waba = d.data?.waba_id;
        const fone = d.data?.phone_number_id;
        if (typeof waba === "string" && typeof fone === "string") {
          ids = { wabaId: waba, phoneNumberId: fone };
          tentar();
        } else if (typeof waba === "string") {
          // Coexistência pode entregar só a WABA no evento; o servidor resolve o número.
          ids = { wabaId: waba, phoneNumberId: null };
          tentar();
        }
      } else if (d.event === "CANCEL") {
        const msg = d.data?.error_message;
        encerrar(
          typeof msg === "string"
            ? { ok: false, motivo: "erro", detalhe: msg }
            : { ok: false, motivo: "cancelado" },
        );
      }
    }
    window.addEventListener("message", ouvir);

    fb.login(
      (r) => {
        const c = r.authResponse?.code;
        if (c) {
          code = c;
          tentar();
        } else {
          encerrar({ ok: false, motivo: "cancelado" });
        }
      },
      {
        config_id: cfg.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      },
    );
  });
}
