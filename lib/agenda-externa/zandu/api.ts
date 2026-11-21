/**
 * Cliente HTTP da API aberta do Zandu — só o que a integração usa.
 *
 * Documentação: https://api.zandu.com.br/docs. Token gerado em Conta > Dispositivos
 * e API, enviado como `Authorization: Bearer`. A API tem limite por token e cota
 * diária em endpoints de agendamento — por isso o CRM NÃO relê a agenda: recebe os
 * avisos (webhook) e só consulta a pessoa quando o aviso vem sem o celular.
 */
import { z } from "zod";

const BASE = "https://api.zandu.com.br";

/** Token recusado (401/403) — a tela pede um novo. */
export class TokenZanduInvalido extends Error {
  constructor() {
    super("O Zandu recusou o token.");
  }
}

export class FalhaNoZandu extends Error {}

const texto = z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? "" : String(v).trim()));

export const pessoaSchema = z.object({ personId: texto, name: texto, phone: texto, phone2: texto }).partial().passthrough();
export type PessoaZandu = z.infer<typeof pessoaSchema>;

export interface ClienteZandu {
  /** Confere o token com uma leitura leve (catálogo de serviços). */
  conferirToken(): Promise<void>;
  pessoa(personId: string): Promise<PessoaZandu | null>;
}

export function criarClienteZandu(opts: { token: string; timeoutMs?: number; fetchImpl?: typeof fetch }): ClienteZandu {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function get(caminho: string): Promise<unknown> {
    let resp: Response;
    try {
      resp = await f(`${BASE}${caminho}`, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new FalhaNoZandu(err instanceof Error && err.name === "TimeoutError" ? "o Zandu demorou a responder" : "sem conexão com o Zandu");
    }
    if (resp.status === 401 || resp.status === 403) throw new TokenZanduInvalido();
    if (resp.status === 404) return null;
    if (resp.status === 429) throw new FalhaNoZandu("limite de consultas do Zandu atingido; tenta de novo mais tarde");
    if (!resp.ok) throw new FalhaNoZandu(`o Zandu respondeu ${resp.status}`);
    return resp.json().catch(() => {
      throw new FalhaNoZandu("resposta do Zandu fora do formato");
    });
  }

  return {
    async conferirToken() {
      await get("/services");
    },
    async pessoa(personId) {
      const corpo = await get(`/persons/${encodeURIComponent(personId)}`);
      if (!corpo) return null;
      const r = pessoaSchema.safeParse(corpo);
      return r.success ? r.data : null;
    },
  };
}
