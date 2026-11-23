/**
 * Cliente HTTP da API aberta do Zandu — só o que a integração usa.
 *
 * Documentação: https://api.zandu.com.br/docs. Token gerado em Conta > Dispositivos
 * e API, enviado como `Authorization: Bearer`. A API tem limite por token e cota
 * diária em endpoints de agendamento — por isso o CRM NÃO relê a agenda: recebe os
 * avisos (webhook) e completa pela API só o que o aviso não traz. A única leitura em
 * lote é a importação inicial (`importar.ts`), uma vez por conexão, pedida pela tela.
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
  /** Catálogo: código do serviço → nome ("1 - Avaliação"). */
  servicos(): Promise<Map<string, string>>;
  /** Agendas ativas na API: código → nome ("Sala 1"). */
  agendas(): Promise<Map<string, string>>;
  /** Um agendamento completo (mesma forma do item de `data` no aviso); null se não existe mais. */
  agendamento(appointmentId: string): Promise<Record<string, unknown> | null>;
  /** Agendamentos de UMA pessoa pelo telefone (o endpoint exige telefone; cota diária). */
  agendamentosDoTelefone(phone: string, de: string, ate: string): Promise<Record<string, unknown>[]>;
  /** Relatório "Pessoas com agendamento": uma linha por agendamento, com telefone — sem código. */
  telefonesComAgendamento(de: string, ate: string): Promise<string[]>;
}

const objetoSchema = z.record(z.string(), z.unknown());
const relatorioSchema = z.object({
  rows: z.array(z.object({ phone: texto, status: texto }).partial().passthrough()).nullish(),
});

const itemDoCatalogoSchema = z.object({ id: texto, serviceId: texto, name: texto }).partial();
const agendasSchema = z.object({
  schedulers: z.array(z.object({ scheduleId: texto, label: texto }).partial()).nullish(),
});

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
    async servicos() {
      const corpo = await get("/services");
      const mapa = new Map<string, string>();
      for (const s of Array.isArray(corpo) ? corpo : []) {
        const r = itemDoCatalogoSchema.safeParse(s);
        const id = r.success ? r.data.id || r.data.serviceId : "";
        if (r.success && id && r.data.name) mapa.set(id, r.data.name);
      }
      return mapa;
    },
    async agendas() {
      // Só para ler os nomes: o período não importa, um dia basta.
      const hoje = new Date().toISOString().slice(0, 10);
      const r = agendasSchema.safeParse(await get(`/schedulers/schedules?from=${hoje}&to=${hoje}`));
      const mapa = new Map<string, string>();
      for (const a of (r.success ? r.data.schedulers : null) ?? []) if (a.scheduleId && a.label) mapa.set(a.scheduleId, a.label);
      return mapa;
    },
    async agendamento(appointmentId) {
      const r = objetoSchema.safeParse(await get(`/schedulers/appointments/${encodeURIComponent(appointmentId)}`));
      return r.success && r.data.appointmentId ? r.data : null;
    },
    async agendamentosDoTelefone(phone, de, ate) {
      const q = new URLSearchParams({ phone, from: de, to: ate });
      const corpo = await get(`/schedulers/appointments?${q.toString()}`);
      return (Array.isArray(corpo) ? corpo : [])
        .map((a) => objetoSchema.safeParse(a))
        .filter((r) => r.success)
        .map((r) => r.data!);
    },
    async telefonesComAgendamento(de, ate) {
      const q = new URLSearchParams({ from: de, to: ate });
      const r = relatorioSchema.safeParse(await get(`/reports/customers/schedule?${q.toString()}`));
      const telefones = new Set<string>();
      for (const l of (r.success ? r.data.rows : null) ?? []) {
        const fone = (l.phone ?? "").replace(/\D/g, "");
        if (fone.length >= 10) telefones.add(fone);
      }
      return [...telefones];
    },
  };
}
