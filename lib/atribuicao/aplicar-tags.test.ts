import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { aplicarTagsDeOrigem } from "./aplicar-tags";

interface Estado {
  tags: string[] | null; // null = lead não existe
  pontos: Array<Record<string, unknown>>;
  meta: { campaign_name: string | null; ad_name: string | null } | null;
  falhaNoUpdate?: boolean;
  atualizacoes: Array<{ tags: string[]; filtros: Record<string, unknown> }>;
  eventos: number;
}

/** Banco de mentira: responde as três leituras e anota o que foi gravado. */
function fakeDb(e: Estado): SupabaseClient {
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let patch: { tags: string[] } | null = null;
    const q: Record<string, unknown> = {};
    const retorna = () => {
      if (patch) {
        if (e.falhaNoUpdate) return { error: { message: "boom" } };
        e.atualizacoes.push({ tags: patch.tags, filtros: { ...filtros } });
        e.tags = patch.tags;
        return { error: null };
      }
      return { data: null, error: null };
    };
    q.select = () => q;
    q.eq = (campo: string, valor: unknown) => {
      filtros[campo] = valor;
      return q;
    };
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: e.pontos, error: null });
    q.update = (p: { tags: string[] }) => {
      patch = p;
      return q;
    };
    q.maybeSingle = () => {
      if (tabela === "crm_leads") return Promise.resolve({ data: e.tags === null ? null : { tags: e.tags }, error: null });
      if (tabela === "meta_ads_ad_metadata") return Promise.resolve({ data: e.meta, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(retorna()).then(res);
    return q;
  };
  return { from, rpc: () => (e.eventos += 1) } as unknown as SupabaseClient;
}

const IDS = { organizationId: "org-1", leadId: "lead-1" };
const estado = (p: Partial<Estado> = {}): Estado => ({
  tags: [],
  pontos: [],
  meta: null,
  atualizacoes: [],
  eventos: 0,
  ...p,
});
const pontoCtwa = (extra: Record<string, unknown> = {}) => ({
  canal: "meta_ads",
  utm_source: null,
  landing_url: "https://www.instagram.com/p/x/",
  referrer: null,
  campaign_name: null,
  ad_name: null,
  ad_id: "123456789",
  ...extra,
});

describe("aplicarTagsDeOrigem", () => {
  it("⭐ lead de anúncio do Instagram ganha Meta Ads + Instagram + campanha + anúncio (nomes vindos da Meta)", async () => {
    const e = estado({ pontos: [pontoCtwa()], meta: { campaign_name: "Botox Out/26", ad_name: "Vídeo 1" } });
    const r = await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(r.aplicadas).toEqual(["origem:meta-ads", "origem:instagram", "campanha:Botox Out/26", "anuncio:Vídeo 1"]);
    expect(e.tags).toEqual(r.aplicadas);
  });

  it("⭐ grava filtrando pela organização (service role não tem RLS)", async () => {
    const e = estado({ pontos: [pontoCtwa()] });
    await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(e.atualizacoes[0]!.filtros).toMatchObject({ id: "lead-1", organization_id: "org-1" });
  });

  it("⭐ NÃO emite evento: lead.tag_added dispararia automação já configurada", async () => {
    const e = estado({ pontos: [pontoCtwa()] });
    await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(e.eventos).toBe(0);
  });

  it("preserva as tags que o lead já tinha", async () => {
    const e = estado({ tags: ["vip", "temperatura:quente"], pontos: [pontoCtwa()] });
    await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(e.tags).toEqual(["vip", "temperatura:quente", "origem:meta-ads", "origem:instagram"]);
  });

  it("⭐ idempotente: segunda chamada não grava nada", async () => {
    const e = estado({ pontos: [pontoCtwa()], meta: { campaign_name: "C", ad_name: "A" } });
    const db = fakeDb(e);
    await aplicarTagsDeOrigem(db, IDS);
    const segunda = await aplicarTagsDeOrigem(db, IDS);
    expect(segunda.aplicadas).toEqual([]);
    expect(e.atualizacoes).toHaveLength(1);
  });

  it("⭐ nome que chega DEPOIS acrescenta campanha/anúncio sem repetir a origem", async () => {
    const e = estado({ pontos: [pontoCtwa()] });
    const db = fakeDb(e);
    await aplicarTagsDeOrigem(db, IDS);
    expect(e.tags).toEqual(["origem:meta-ads", "origem:instagram"]);
    e.meta = { campaign_name: "Botox", ad_name: "V1" };
    const r = await aplicarTagsDeOrigem(db, IDS);
    expect(r.aplicadas).toEqual(["campanha:Botox", "anuncio:V1"]);
  });

  it("⭐ primeiro toque ganha: campanha já definida (ou corrigida à mão) não é sobrescrita", async () => {
    const e = estado({ tags: ["campanha:Corrigida"], pontos: [pontoCtwa()], meta: { campaign_name: "Da Meta", ad_name: "A" } });
    const r = await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(e.tags).toContain("campanha:Corrigida");
    expect(e.tags).not.toContain("campanha:Da Meta");
    expect(r.aplicadas).toContain("anuncio:A");
  });

  it("usa o PRIMEIRO ponto de mídia, pulando um ponto 'outro' mais antigo", async () => {
    const e = estado({
      pontos: [pontoCtwa({ canal: "outro", landing_url: null, ad_id: null }), pontoCtwa({ canal: "google_ads", landing_url: null, ad_id: null })],
    });
    const r = await aplicarTagsDeOrigem(fakeDb(e), IDS);
    expect(r.aplicadas).toEqual(["origem:google-ads"]);
  });

  it("lead sem ponto de contato, ou só com 'outro': nada a fazer", async () => {
    const e = estado({ pontos: [pontoCtwa({ canal: "outro" })] });
    expect((await aplicarTagsDeOrigem(fakeDb(e), IDS)).aplicadas).toEqual([]);
    expect(e.atualizacoes).toHaveLength(0);
  });

  it("lead inexistente: nada a fazer", async () => {
    expect((await aplicarTagsDeOrigem(fakeDb(estado({ tags: null })), IDS)).aplicadas).toEqual([]);
  });

  it("⭐ NUNCA lança: falha ao gravar vira aviso e o lead segue", async () => {
    const e = estado({ pontos: [pontoCtwa()], falhaNoUpdate: true });
    await expect(aplicarTagsDeOrigem(fakeDb(e), IDS)).resolves.toEqual({ aplicadas: [] });
  });
});
