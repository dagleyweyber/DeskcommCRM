import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O CONSERTO DO GAP — canal oficial da Meta agora roda os efeitos de
 * pós-entrada (opt-out, nascimento do lead, despacho do agente).
 *
 * Antes desta mudança, `ingestMetaInbound` gravava a mensagem e parava: sem
 * `aplicarEfeitosPosEntrada`, nenhum lead nascia, nenhum opt-out era
 * respeitado, e o agente nunca era acordado — silenciosamente, porque a
 * rota sempre respondia 200 (a Meta reentregaria em loop qualquer coisa
 * diferente de 2xx). Medido no achado desta sessão: o mesmo defeito que o
 * commit `b02f546e` já tinha corrigido pro WAHA e pro canal Zernio.
 *
 * Junto, prova a Fase A da atribuição de anúncio: `referral` (ctwa_clid) vira
 * `crm_leads.source_metadata` — o dado que faltava pra saber QUAL anúncio
 * vendeu, não só que a origem foi "meta_ads".
 *
 * Invariante de banco (não unit com mock) porque `ingestMetaInbound` chama
 * RPCs reais (`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`,
 * `fn_mark_conversation_message`, `emit_event`) e o gatilho
 * `fn_seed_default_pipeline_for_org` — nada disso existe fora do Postgres.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "6e7ac10d-0000-4000-8000-000000000001";
const PHONE_NUMBER_ID = "meta-cloud-invariant-pnid";

async function criarSessaoMetaCloud(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into channel_sessions
       (organization_id, provider, meta_phone_number_id, webhook_secret_encrypted, waha_session_name)
     values ($1, 'meta_cloud', $2, '\\x00'::bytea, null)
     returning id`,
    [ORG, PHONE_NUMBER_ID],
  );
  return rows[0]!.id;
}

function evento(overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    kind: "inbound_message",
    wabaId: "waba-1",
    phoneNumberId: PHONE_NUMBER_ID,
    externalId: `wamid.${Math.random().toString(36).slice(2)}`,
    from: "553199988877",
    profileName: "Lead do Anúncio",
    sentAt: new Date(),
    type: "text",
    text: "oi, vi o anúncio",
    media: null,
    adReferral: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-meta-cloud-invariant', 'Meta Cloud LTDA', 'Meta Cloud')
     on conflict (id) do nothing`,
    [ORG],
  );
  // UMA sessão só: `sessionByPhoneNumberId` usa `.maybeSingle()`, que
  // ESTOURA se houver mais de uma linha com o mesmo `meta_phone_number_id` —
  // criar uma por teste quebraria o segundo `it()` em diante.
  await criarSessaoMetaCloud();
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("ingestMetaInbound — o conserto do pos-entrada", () => {
  it("⭐ mensagem pelo canal oficial agora cria lead — antes do conserto, zero", async () => {
    const r = await ingestMetaInbound(db, evento());
    expect(r.status).toBe("ingested");
    if (r.status !== "ingested") return;

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where organization_id = $1",
      [ORG],
    );
    expect(rows[0]!.n, "o lead tem de nascer — era exatamente isto que faltava").toBe("1");
  });

  it("⭐ ctwa_clid do referral vira source_metadata no lead", async () => {
    const r = await ingestMetaInbound(
      db,
      evento({
        from: "553199912345",
        adReferral: {
          clickId: "AbCdEf123",
          sourceId: "120210000000000",
          sourceType: "ad",
          headline: "Promoção de Botox",
          sourceUrl: "https://fb.me/xyz",
        },
      }),
    );
    expect(r.status).toBe("ingested");

    const { rows } = await pool.query<{ source_metadata: Record<string, unknown> }>(
      `select l.source_metadata
         from crm_leads l join contacts c on c.id = l.contact_id
        where c.phone_number = '+553199912345'`,
    );
    expect(rows[0]!.source_metadata).toEqual({
      ad_click_id: "AbCdEf123",
      ad_click_id_type: "ctwa_clid",
      ad_id: "120210000000000",
      ad_headline: "Promoção de Botox",
      ad_source_url: "https://fb.me/xyz",
    });
  });

  it("opt-out também roda: contato bloqueado não abre demanda nova", async () => {
    const numero = "553199955443";

    // Primeira mensagem cria o contato e o primeiro lead; fecha esse lead e
    // bloqueia o contato — cenário de quem comprou e depois pediu pra sair.
    await ingestMetaInbound(db, evento({ from: numero, externalId: "wamid.stop1" }));
    await pool.query(
      `update crm_leads set status = 'won', closed_at = now()
         where contact_id = (select id from contacts where phone_number = $1)`,
      [`+${numero}`],
    );
    await pool.query("update contacts set is_blocked = true where phone_number = $1", [`+${numero}`]);

    // Segunda mensagem do MESMO contato, já bloqueado: sem o opt-out rodando
    // (o defeito original), isto abriria demanda nova — é exatamente o que
    // se prova que NÃO acontece.
    await ingestMetaInbound(db, evento({ from: numero, externalId: "wamid.stop2" }));

    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from crm_leads l join contacts c on c.id = l.contact_id
        where c.phone_number = $1 and l.status = 'open'`,
      [`+${numero}`],
    );
    expect(rows[0]!.n, "contato bloqueado não abre demanda nova").toBe("0");
  });
});
