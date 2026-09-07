/**
 * Registra o número na Cloud API (`POST /{phone_number_id}/register`).
 *
 * Achado ao vivo: um número adicionado pelo caminho "Configurações do Negócio →
 * Números de telefone" (em vez do assistente padrão "Início rápido") fica com
 * `status: PENDING` e toda tentativa de ENVIAR mensagem retorna `133010 Account
 * not registered` — mesmo com o número já verificado por SMS
 * (`code_verification_status: VERIFIED`) e a WABA aprovada. O assistente padrão
 * chama este endpoint por trás; o caminho manual, não. Ninguém percebe até
 * mandar a primeira mensagem de verdade e o número "não existir" no WhatsApp.
 *
 * O PIN é de verificação em duas etapas do NÚMERO (não do usuário) — qualquer
 * valor de 6 dígitos serve na primeira chamada; não precisa ser lembrado depois,
 * porque quem re-registra é sempre a API com este mesmo fluxo, nunca um humano
 * digitando.
 *
 * Não bloqueia a conexão se falhar: a credencial já foi validada
 * (`validateMetaCredentials`) antes desta chamada — um número que falha aqui
 * pode já estar registrado (chamar de novo é seguro) ou ter um motivo que não
 * invalida o par phone_number_id/token. Quem chama decide se avisa o operador.
 */
export interface RegistroDeNumero {
  ok: boolean;
  motivo?: string;
}

export async function registerMetaPhoneNumber(input: {
  phoneNumberId: string;
  token: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
}): Promise<RegistroDeNumero> {
  const version = input.graphVersion ?? process.env.META_GRAPH_VERSION ?? "v22.0";
  const fetchFn = input.fetchImpl ?? fetch;
  const pin = String(Math.floor(100000 + Math.random() * 900000));

  try {
    const res = await fetchFn(
      `https://graph.facebook.com/${version}/${input.phoneNumberId}/register`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { message?: string; error_data?: { details?: string } };
    };

    if (!res.ok || body.error) {
      return {
        ok: false,
        motivo: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
      };
    }

    return { ok: body.success === true };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}
