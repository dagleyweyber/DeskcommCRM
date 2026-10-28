import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PontoDeContato } from "./ponto-de-contato";

const registrar = vi.hoisted(() => vi.fn(async () => ({ gravados: 1 })));
vi.mock("./registrar", () => ({ registrarPontosDeContato: registrar }));

import { ligarCliqueAoLead } from "./ligar-clique";

interface Clique {
  id: string;
  parametros: Record<string, unknown> | null;
  created_at: string;
  usado_em: string | null;
}
interface Estado {
  clique: Clique | null;
  /** o update condicionado perde a corrida (outro consumiu antes). */
  perdeACorrida?: boolean;
  falhaNaLeitura?: boolean;
  tabelasLidas: string[];
  filtros: Array<Record<string, unknown>>;
  consumos: Array<Record<string, unknown>>;
}

function fakeDb(e: Estado): SupabaseClient {
  const from = (tabela: string) => {
    e.tabelasLidas.push(tabela);
    const filtros: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => ((filtros[c] = v), q);
    q.is = (c: string, v: unknown) => ((filtros[`${c} is`] = v), q);
    q.update = (p: Record<string, unknown>) => ((patch = p), q);
    q.maybeSingle = () => {
      e.filtros.push({ ...filtros });
      if (e.falhaNaLeitura) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: e.clique, error: null });
    };
    q.then = (res: (v: unknown) => unknown) => {
      e.filtros.push({ ...filtros });
      if (patch) {
        if (e.perdeACorrida || e.clique?.usado_em) return Promise.resolve({ data: [], error: null }).then(res);
        e.consumos.push(patch);
        return Promise.resolve({ data: [{ id: e.clique?.id }], error: null }).then(res);
      }
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const IDS = { organizationId: "org-1", leadId: "lead-1", contactId: "contato-1" };
const agora = () => new Date().toISOString();
const diasAtras = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
const estado = (p: Partial<Estado> = {}): Estado => ({
  clique: { id: "clq-1", parametros: { utm_source: "google", gclid: "Cj0K_ABC", campaign_id: "987654" }, created_at: agora(), usado_em: null },
  tabelasLidas: [],
  filtros: [],
  consumos: [],
  ...p,
});

beforeEach(() => registrar.mockClear());

describe("ligarCliqueAoLead", () => {
  it("⭐ mensagem com o código de um clique válido: vira ponto de contato do lead, via link_whatsapp, com o gclid", async () => {
    const e = estado();
    const r = await ligarCliqueAoLead(fakeDb(e), IDS, "Quero agendar ref:K7M2QX");
    expect(r.ligado).toBe(true);
    expect(registrar).toHaveBeenCalledTimes(1);
    const [, ids, pontos] = registrar.mock.calls[0] as unknown as [unknown, typeof IDS, PontoDeContato[]];
    expect(ids).toEqual(IDS);
    expect(pontos).toHaveLength(1);
    expect(pontos[0]).toMatchObject({ canal: "google_ads", via: "link_whatsapp", clickIdType: "gclid", clickId: "Cj0K_ABC", campaignId: "987654" });
  });

  it("⭐ consome o clique ANTES de registrar e o liga ao lead", async () => {
    const e = estado();
    await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX");
    expect(e.consumos).toHaveLength(1);
    expect(e.consumos[0]).toMatchObject({ lead_id: "lead-1" });
    expect(e.consumos[0]!.usado_em).toBeTruthy();
  });

  it("⭐ filtra pela organização da CONVERSA (service role não tem RLS) e consome só se ainda não usado", async () => {
    const e = estado();
    await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX");
    expect(e.filtros[0]).toMatchObject({ organization_id: "org-1", codigo: "K7M2QX" });
    expect(e.filtros[1]).toMatchObject({ organization_id: "org-1", id: "clq-1", "usado_em is": null });
  });

  it("⭐ mensagem SEM código não toca no banco", async () => {
    const e = estado();
    const r = await ligarCliqueAoLead(fakeDb(e), IDS, "Olá, boa tarde");
    expect(r.ligado).toBe(false);
    expect(e.tabelasLidas).toHaveLength(0);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("código que não existe: não liga", async () => {
    const r = await ligarCliqueAoLead(fakeDb(estado({ clique: null })), IDS, "ref:K7M2QX");
    expect(r.ligado).toBe(false);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("⭐ clique já usado não liga de novo (mesma atribuição não vale para duas conversas)", async () => {
    const e = estado();
    e.clique!.usado_em = agora();
    expect((await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX")).ligado).toBe(false);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("⭐ clique com mais de 14 dias não liga", async () => {
    const e = estado();
    e.clique!.created_at = diasAtras(15);
    expect((await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX")).ligado).toBe(false);
    expect(e.consumos).toHaveLength(0);
  });

  it("⭐ perdeu a corrida (outro consumiu no meio): não registra em dobro", async () => {
    const e = estado({ perdeACorrida: true });
    expect((await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX")).ligado).toBe(false);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("com primeiro toque guardado no clique: dois pontos, ambos via link_whatsapp", async () => {
    const e = estado();
    e.clique!.parametros = {
      utm_source: "google",
      gclid: "ULTIMO",
      dc_primeiro_contato: JSON.stringify({ ts: "2026-10-20T12:00:00.000Z", utm_source: "facebook", fbclid: "PRIMEIRO" }),
    };
    await ligarCliqueAoLead(fakeDb(e), IDS, "ref:K7M2QX");
    const pontos = (registrar.mock.calls[0] as unknown as [unknown, unknown, PontoDeContato[]])[2];
    expect(pontos.map((p) => p.canal)).toEqual(["meta_ads", "google_ads"]);
    expect(pontos.every((p) => p.via === "link_whatsapp")).toBe(true);
  });

  it("⭐ NUNCA lança: erro de leitura vira aviso e a mensagem segue", async () => {
    await expect(ligarCliqueAoLead(fakeDb(estado({ falhaNaLeitura: true })), IDS, "ref:K7M2QX")).resolves.toEqual({ ligado: false });
  });
});
