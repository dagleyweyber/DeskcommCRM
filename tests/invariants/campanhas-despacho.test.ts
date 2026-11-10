import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { dispatchCampaignsTick } from "@/lib/campaigns/dispatch";
import type { Message } from "@/lib/types/messaging";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * UM TICK DO DESPACHANTE, contra Postgres real.
 *
 * `sendMessageHandler` é injetado por dublê (`sendMessageFn`) — a chamada
 * real à Meta é responsabilidade do adapter, já provada nos testes DELE
 * (`tests/unit/channel-adapter-meta.test.ts`). O que se prova aqui é a
 * ORQUESTRAÇÃO: pegar `pending`, marcar `sending`→`sent`/`failed`, respeitar
 * janela/limite diário (`lib/automation/throttle.ts`, não reimplementado),
 * e fechar a campanha quando não sobra ninguém.
 *
 * `ensureConversation` roda de VERDADE (é só Postgres, sem rede) — é código
 * de produção rodando, não um SQL escrito ao lado que prova o banco em vez
 * do código, mesma filosofia de `pgComoSupabase`.
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
const admin = pgComoSupabase(pool);

const ORG = "dc0ca11e-0000-4000-8000-000000000001";
const SESSION = "dc0ca11e-0000-4000-8000-000000000002";

let contatoA = "";
let contatoB = "";

async function novaCampanha(status: "queued" | "running" = "queued") {
  const { rows } = await pool.query<{ id: string }>(
    `insert into whatsapp_campaigns
       (organization_id, name, channel_session_id, template_name, template_language,
        variable_mapping, audience_filter, status, total_recipients)
     values ($1, 'Campanha de teste', $2, 'oferta', 'pt_BR', '{}'::jsonb, '{"kind":"tag","tag":"x"}'::jsonb, $3, 2)
     returning id`,
    [ORG, SESSION, status],
  );
  return rows[0]!.id;
}

async function novoDestinatario(campaignId: string, contactId: string, valores: Record<string, string>) {
  await pool.query(
    `insert into whatsapp_campaign_recipients (campaign_id, organization_id, contact_id, resolved_values, status)
     values ($1, $2, $3, $4, 'pending')`,
    [campaignId, ORG, contactId, JSON.stringify(valores)],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-campanhas-despacho', 'Despacho LTDA', 'Despacho') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', '5511900000000', '999', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, channel_session_id, name, language, status, components, contract_hash)
     values ($1, '999', $2, 'oferta', 'pt_BR', 'APPROVED', $3::jsonb, 'hash-teste')`,
    [ORG, SESSION, JSON.stringify([{ type: "BODY", text: "Olá {{1}}, aproveite!" }])],
  );

  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, phone_number, source) values
       ($1, 'Contato A', '+5511900000001', 'whatsapp'),
       ($1, 'Contato B', '+5511900000002', 'whatsapp')
     returning id`,
    [ORG],
  );
  contatoA = rows[0]!.id;
  contatoB = rows[1]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

/** Dublê de `sendMessageHandler` — sempre "envia com sucesso". */
function sendFnSucesso() {
  return vi.fn(
    async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> =>
      ({ id: "msg-1", status: "sent", external_id: "wamid.FAKE", type: "template" }) as unknown as Message,
  );
}

describe("um tick processa os pendentes e completa a campanha", () => {
  it("⭐ manda pra cada pendente com os valores certos, e fecha `completed` sem sobrar nada", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });
    await novoDestinatario(campaignId, contatoB, { "1": "Bia" });

    const sendFn = sendFnSucesso();
    const resumo = await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T14:00:00Z"), // dentro da janela 7h-22h
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(2);
    expect(sendFn).toHaveBeenCalledTimes(2);
    const chamadas = sendFn.mock.calls.map((c) => (c[2] as { template_values: Record<string, string> }).template_values);
    expect(chamadas).toEqual(expect.arrayContaining([{ "1": "Ana" }, { "1": "Bia" }]));

    const { rows: destinatarios } = await pool.query<{ status: string; external_id: string | null }>(
      "select status, external_id from whatsapp_campaign_recipients where campaign_id = $1",
      [campaignId],
    );
    expect(destinatarios.every((d) => d.status === "sent" && d.external_id === "wamid.FAKE")).toBe(true);

    const { rows: campanha } = await pool.query<{ status: string; sent_count: number; completed_at: string | null }>(
      "select status, sent_count, completed_at from whatsapp_campaigns where id = $1",
      [campaignId],
    );
    expect(campanha[0]).toMatchObject({ status: "completed", sent_count: 2 });
    expect(campanha[0]!.completed_at).not.toBeNull();

    // A conversa foi criada de verdade — `ensureConversation` rodando código
    // de produção, não um stub.
    const { rows: conversas } = await pool.query(
      "select count(*)::int as n from conversations where organization_id = $1 and channel_session_id = $2",
      [ORG, SESSION],
    );
    expect(conversas[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("envio que falha marca `failed` no destinatário e NÃO trava os outros", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });
    await novoDestinatario(campaignId, contatoB, { "1": "Bia" });

    let chamada = 0;
    const sendFn = vi.fn(async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> => {
      chamada += 1;
      if (chamada === 1) throw new Error("meta_500: instabilidade");
      return { id: "msg-2", status: "sent", external_id: "wamid.OK", type: "template" } as unknown as Message;
    });

    const resumo = await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T14:00:00Z"),
      timeBudgetMs: 5000,
    });

    expect(resumo.sent).toBe(1);
    expect(resumo.failed).toBe(1);

    const { rows } = await pool.query<{ status: string; error_message: string | null }>(
      "select status, error_message from whatsapp_campaign_recipients where campaign_id = $1 order by created_at",
      [campaignId],
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]!.error_message).toContain("instabilidade");
    expect(rows[1]).toMatchObject({ status: "sent" });
  });
});

describe("fora da janela de horário, o tick não manda nada", () => {
  it("campanha `queued` vira `running` mas nenhum destinatário sai de `pending`", async () => {
    const campaignId = await novaCampanha("queued");
    await novoDestinatario(campaignId, contatoA, { "1": "Ana" });

    const sendFn = sendFnSucesso();
    await dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T03:00:00Z"), // 3h da manhã — fora da janela
      timeBudgetMs: 5000,
    });

    expect(sendFn).not.toHaveBeenCalled();
    const { rows } = await pool.query<{ status: string }>(
      "select status from whatsapp_campaign_recipients where campaign_id = $1",
      [campaignId],
    );
    expect(rows[0]!.status).toBe("pending");

    const { rows: campanha } = await pool.query<{ status: string }>(
      "select status from whatsapp_campaigns where id = $1",
      [campaignId],
    );
    expect(campanha[0]!.status).toBe("running");
  });
});

describe("canais diferentes disparam ao mesmo tempo", () => {
  it("⭐ campanhas de dois números saem intercaladas — uma loja não espera a outra terminar", async () => {
    const canais = [
      { id: "dc0ca11e-0000-4000-8000-0000000000a1", fone: "5511900000091", waba: "991" },
      { id: "dc0ca11e-0000-4000-8000-0000000000a2", fone: "5511900000092", waba: "992" },
    ];
    const campanhas: string[] = [];
    for (const canal of canais) {
      await pool.query(
        `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
         values ($1, $2, 'meta_cloud', $3, $4, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
        [canal.id, ORG, canal.fone, canal.waba],
      );
      await pool.query(
        `insert into meta_templates (organization_id, waba_id, channel_session_id, name, language, status, components, contract_hash)
         values ($1, $4, $2, 'oferta', 'pt_BR', 'APPROVED', $3::jsonb, 'hash-teste')`,
        [ORG, canal.id, JSON.stringify([{ type: "BODY", text: "Olá {{1}}, aproveite!" }]), canal.waba],
      );
      const { rows } = await pool.query<{ id: string }>(
        `insert into whatsapp_campaigns
           (organization_id, name, channel_session_id, template_name, template_language,
            variable_mapping, audience_filter, status, total_recipients)
         values ($1, 'Campanha do canal', $2, 'oferta', 'pt_BR', '{}'::jsonb, '{"kind":"tag","tag":"x"}'::jsonb, 'queued', 2)
         returning id`,
        [ORG, canal.id],
      );
      campanhas.push(rows[0]!.id);
      await novoDestinatario(rows[0]!.id, contatoA, { "1": "Ana" });
      await novoDestinatario(rows[0]!.id, contatoB, { "1": "Bia" });
    }

    const ordem: string[] = [];
    const sendFn = vi.fn(async (_admin: unknown, ctx: unknown, _input: unknown): Promise<Message> => {
      ordem.push((ctx as { actor: { id: string } }).actor.id);
      return { id: "msg-p", status: "sent", external_id: "wamid.P", type: "template" } as unknown as Message;
    });

    await dispatchCampaignsTick(admin, {
      // A pausa precisa ceder a vez de verdade; sem isso a ordem não prova nada. Longa o
      // bastante para o outro canal passar pelos freios (várias consultas num pool de 3
      // conexões) antes do segundo envio deste — 5 ms media a fila do pool, não o despachante.
      sleep: () => new Promise((r) => setTimeout(r, 300)),
      sendMessageFn: sendFn,
      now: () => new Date("2026-01-01T14:00:00Z"),
      timeBudgetMs: 5000,
    });

    const minhas = ordem.filter((id) => campanhas.includes(id));
    expect(minhas).toHaveLength(4);
    // Em fila a ordem seria A,A,B,B: o segundo envio já seria do mesmo canal do primeiro.
    expect(minhas[1]).not.toBe(minhas[0]);
  });
});

describe("velocidade da campanha", () => {
  async function campanhaComVelocidade(velocidade: string | null, destinatarios: number) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into whatsapp_campaigns
         (organization_id, name, channel_session_id, template_name, template_language,
          variable_mapping, audience_filter, status, total_recipients, velocidade)
       values ($1, 'Campanha de velocidade', $2, 'oferta', 'pt_BR', '{}'::jsonb, '{"kind":"tag","tag":"x"}'::jsonb,
               'queued', $3, coalesce($4, 'cuidadosa'))
       returning id`,
      [ORG, SESSION, destinatarios, velocidade],
    );
    const id = rows[0]!.id;
    const { rows: contatos } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name, phone_number, source)
       select $1, 'Velocidade ' || g, '+55119' || lpad((random() * 99999999)::int::text, 8, '0') || g::text, 'whatsapp'
         from generate_series(1, $2) g
       returning id`,
      [ORG, destinatarios],
    );
    for (const c of contatos) await novoDestinatario(id, c.id, { "1": "Fulano" });
    return id;
  }

  /** Dublê que registra quantos envios DESTA campanha estavam em voo quando cada um começou. */
  function sendFnQueMede(campaignId: string, falha = false) {
    let emVoo = 0;
    const sequencia: number[] = [];
    const fn = vi.fn(async (_admin: unknown, ctx: unknown, _input: unknown): Promise<Message> => {
      if ((ctx as { actor: { id: string } }).actor.id !== campaignId) {
        return { id: "msg-x", status: "sent", external_id: "wamid.X", type: "template" } as unknown as Message;
      }
      emVoo += 1;
      sequencia.push(emVoo);
      await new Promise((r) => setTimeout(r, 80));
      emVoo -= 1;
      if (falha) throw new Error("meta_131026: número recusado");
      return { id: "msg-v", status: "sent", external_id: "wamid.V", type: "template" } as unknown as Message;
    });
    return { fn, sequencia };
  }

  const tick = (sendMessageFn: ReturnType<typeof sendFnSucesso>) =>
    dispatchCampaignsTick(admin, {
      sleep: async () => {},
      sendMessageFn,
      now: () => new Date("2026-01-01T14:00:00Z"),
      timeBudgetMs: 10_000,
    });

  it("⭐ sem escolha, a campanha anda no ritmo de sempre: um envio por vez", async () => {
    const id = await campanhaComVelocidade(null, 3);
    const { fn, sequencia } = sendFnQueMede(id);
    await tick(fn);
    expect(sequencia).toEqual([1, 1, 1]);
  });

  it("⭐ rápida manda em lotes de 5 ao mesmo tempo, e todos saem", async () => {
    const id = await campanhaComVelocidade("rapida", 10);
    const { fn, sequencia } = sendFnQueMede(id);
    await tick(fn);
    expect(Math.max(...sequencia)).toBe(5);
    const { rows } = await pool.query<{ status: string; n: number }>(
      "select status, count(*)::int as n from whatsapp_campaign_recipients where campaign_id = $1 group by status",
      [id],
    );
    expect(rows).toEqual([{ status: "sent", n: 10 }]);
  });

  it("⭐ freio: depois de uma rodada de falhas seguidas a campanha rápida desacelera para um por vez", async () => {
    const id = await campanhaComVelocidade("rapida", 7);
    const { fn, sequencia } = sendFnQueMede(id, true);
    await tick(fn);
    expect(sequencia).toHaveLength(7);
    expect(Math.max(...sequencia.slice(0, 5))).toBe(5);
    expect(sequencia.slice(5)).toEqual([1, 1]);
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from whatsapp_campaign_recipients where campaign_id = $1 and status = 'failed'",
      [id],
    );
    expect(rows[0]!.n).toBe(7);
  });

  it("o banco recusa velocidade fora da lista", async () => {
    await expect(campanhaComVelocidade("turbo", 1)).rejects.toThrow(/velocidade/);
  });
});

describe("parada automática, espera em blocos e painel (migration 0218)", () => {
  const agora = new Date("2026-01-01T14:00:00Z");
  const tick = (sendMessageFn: ReturnType<typeof sendFnSucesso>, timeBudgetMs = 10_000) =>
    dispatchCampaignsTick(admin, { sleep: async () => {}, sendMessageFn, now: () => agora, timeBudgetMs });

  /** Canal próprio por teste: o estado do modelo e do número de um não vaza para o outro. */
  async function cenario(opcoes: {
    sufixo: string;
    modelo?: { status: string; quality?: string | null };
    destinatarios: number;
    extras?: string;
    valoresExtras?: unknown[];
  }) {
    const canal = `dc0ca11e-0000-4000-8000-0000000b${opcoes.sufixo.padStart(4, "0")}`;
    const waba = `9${opcoes.sufixo}`;
    await pool.query(
      `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
       values ($1, $2, 'meta_cloud', $3, $4, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
      [canal, ORG, `55119${opcoes.sufixo.padStart(8, "0")}`, waba],
    );
    await pool.query(
      `insert into meta_templates (organization_id, waba_id, channel_session_id, name, language, status, quality_score, components, contract_hash)
       values ($1, $2, $3, 'oferta', 'pt_BR', $4, $5, $6::jsonb, 'hash-teste')`,
      [
        ORG,
        waba,
        canal,
        opcoes.modelo?.status ?? "APPROVED",
        opcoes.modelo?.quality ?? null,
        JSON.stringify([{ type: "BODY", text: "Olá {{1}}, aproveite!" }]),
      ],
    );
    const extras = opcoes.extras ? `, ${opcoes.extras}` : "";
    const marcas = (opcoes.valoresExtras ?? []).map((_, i) => `, $${i + 4}`).join("");
    const { rows } = await pool.query<{ id: string }>(
      `insert into whatsapp_campaigns
         (organization_id, name, channel_session_id, template_name, template_language,
          variable_mapping, audience_filter, status, total_recipients${extras})
       values ($1, 'Campanha de freio', $2, 'oferta', 'pt_BR', '{}'::jsonb, '{"kind":"tag","tag":"x"}'::jsonb, 'queued', $3${marcas})
       returning id`,
      [ORG, canal, opcoes.destinatarios, ...(opcoes.valoresExtras ?? [])],
    );
    const id = rows[0]!.id;
    const { rows: contatos } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name, phone_number, source)
       select $1, 'Freio ' || g, '+5521' || $3 || lpad(g::text, 5, '0'), 'whatsapp'
         from generate_series(1, $2) g
       returning id`,
      [ORG, opcoes.destinatarios, opcoes.sufixo.padStart(4, "0")],
    );
    for (const c of contatos) await novoDestinatario(id, c.id, { "1": "Fulano" });
    return { id, canal, contatos: contatos.map((c) => c.id) };
  }

  async function campanha(id: string) {
    const { rows } = await pool.query<{
      status: string;
      pausa_motivo: string | null;
      bloco_enviados: number;
      proximo_bloco_em: Date | null;
    }>("select status, pausa_motivo, bloco_enviados, proximo_bloco_em from whatsapp_campaigns where id = $1", [id]);
    return rows[0]!;
  }

  async function contagem(id: string) {
    const { rows } = await pool.query<{ status: string; n: number }>(
      "select status, count(*)::int as n from whatsapp_campaign_recipients where campaign_id = $1 group by status order by status",
      [id],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  it("⭐ modelo PAUSADO pela Meta: a campanha para com o motivo gravado e ninguém é queimado", async () => {
    const { id } = await cenario({ sufixo: "101", modelo: { status: "PAUSED" }, destinatarios: 3 });
    const sendFn = sendFnSucesso();
    await tick(sendFn);

    expect(sendFn).not.toHaveBeenCalled();
    expect(await campanha(id)).toMatchObject({ status: "paused", pausa_motivo: "modelo_pausado" });
    expect(await contagem(id)).toEqual({ pending: 3 });
  });

  it("⭐ nota amarela para; com a nota dispensada ao retomar, segue", async () => {
    const parada = await cenario({ sufixo: "102", modelo: { status: "APPROVED", quality: "YELLOW" }, destinatarios: 2 });
    await tick(sendFnSucesso());
    expect(await campanha(parada.id)).toMatchObject({ status: "paused", pausa_motivo: "modelo_nota_amarela" });

    const dispensada = await cenario({
      sufixo: "103",
      modelo: { status: "APPROVED", quality: "YELLOW" },
      destinatarios: 2,
      extras: "freios_dispensados",
      valoresExtras: [["modelo_nota_amarela"]],
    });
    await tick(sendFnSucesso());
    expect(await contagem(dispensada.id)).toEqual({ sent: 2 });
  });

  it("⭐ a Meta recusa o modelo no envio (132015): para na hora e o contato VOLTA para a fila", async () => {
    const { id } = await cenario({ sufixo: "104", destinatarios: 4 });
    const sendFn = vi.fn(async (_admin: unknown, _ctx: unknown, _input: unknown): Promise<Message> => {
      throw new Error("meta_132015: Template is paused due to low quality");
    });
    await tick(sendFn);

    expect(sendFn).toHaveBeenCalledTimes(1); // nada depois da primeira recusa
    expect(await campanha(id)).toMatchObject({ status: "paused", pausa_motivo: "modelo_pausado" });
    expect(await contagem(id)).toEqual({ pending: 4 });
  });

  it("⭐ blocos: manda o bloco, marca a espera e não manda mais até ela acabar", async () => {
    const { id } = await cenario({
      sufixo: "105",
      destinatarios: 12,
      extras: "velocidade, bloco_tamanho, bloco_espera_minutos",
      valoresExtras: ["rapida", 10, 30],
    });
    await tick(sendFnSucesso());

    expect(await contagem(id)).toEqual({ pending: 2, sent: 10 });
    const depois = await campanha(id);
    expect(depois.status).toBe("running");
    expect(depois.bloco_enviados).toBe(0);
    expect(new Date(depois.proximo_bloco_em!).getTime()).toBe(agora.getTime() + 30 * 60_000);

    // Ainda na espera: o tick seguinte não manda nada desta campanha.
    await tick(sendFnSucesso());
    expect(await contagem(id)).toEqual({ pending: 2, sent: 10 });

    // Espera vencida: sai o resto e a campanha fecha.
    await pool.query("update whatsapp_campaigns set proximo_bloco_em = $2 where id = $1", [
      id,
      new Date(agora.getTime() - 1000),
    ]);
    await tick(sendFnSucesso());
    expect(await contagem(id)).toEqual({ sent: 12 });
    expect((await campanha(id)).status).toBe("completed");
  });

  it("o banco recusa bloco sem espera (os dois ou nenhum)", async () => {
    await expect(
      cenario({ sufixo: "106", destinatarios: 1, extras: "bloco_tamanho", valoresExtras: [300] }),
    ).rejects.toThrow(/bloco_completo/);
  });

  it("⭐ painel: aceitas, entregues, lidas, respostas, saídas e falhas por código, numa ida só", async () => {
    const { id, canal, contatos } = await cenario({ sufixo: "107", destinatarios: 5 });
    const { rows: conv } = await pool.query<{ id: string; contact_id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id)
       select $1, c, $2 from unnest($3::uuid[]) c returning id, contact_id`,
      [ORG, canal, contatos],
    );
    const conversaDe = new Map(conv.map((c) => [c.contact_id, c.id]));
    const enviadoEm = new Date("2026-01-01T13:00:00Z");
    const estados = ["read", "delivered", "delivered", "failed"]; // o 5º falha já no envio
    for (const [i, contato] of contatos.entries()) {
      if (i === 4) {
        await pool.query(
          "update whatsapp_campaign_recipients set status = 'failed', error_message = 'meta_131026: undeliverable' where campaign_id = $1 and contact_id = $2",
          [id, contato],
        );
        continue;
      }
      const wamid = `wamid.painel.${i}`;
      await pool.query(
        "update whatsapp_campaign_recipients set status = 'sent', external_id = $3, sent_at = $4 where campaign_id = $1 and contact_id = $2",
        [id, contato, wamid, enviadoEm],
      );
      await pool.query(
        `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, sent_via, sent_at, metadata)
         values ($1, $2, $3, $4, $5, 'template', 'outbound', $6, 'automation', $7, $8::jsonb)`,
        [
          ORG,
          conversaDe.get(contato),
          canal,
          contato,
          wamid,
          estados[i],
          enviadoEm,
          JSON.stringify(estados[i] === "failed" ? { failure_code: 131049 } : {}),
        ],
      );
    }
    // O 1º respondeu uma hora depois; o 2º pediu para sair; o 3º respondeu só 4 dias depois (não conta).
    const umaHora = new Date(enviadoEm.getTime() + 3600_000);
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, sent_via, sent_at, body)
       values ($1, $2, $3, $4, 'wamid.resp.0', 'text', 'inbound', 'received', 'user', $5, 'Quero!'),
              ($1, $6, $3, $7, 'wamid.resp.2', 'text', 'inbound', 'received', 'user', $8, 'Oi')`,
      [
        ORG,
        conversaDe.get(contatos[0]!),
        canal,
        contatos[0],
        umaHora,
        conversaDe.get(contatos[2]!),
        contatos[2],
        new Date(enviadoEm.getTime() + 4 * 86400_000),
      ],
    );
    await pool.query("update contacts set is_blocked = true, blocked_reason = 'stop_keyword', blocked_at = $2 where id = $1", [
      contatos[1],
      umaHora,
    ]);

    const { rows } = await pool.query<{ r: Record<string, unknown> }>(
      "select public.fn_resultado_da_campanha($1, $2) as r",
      [ORG, id],
    );
    expect(rows[0]!.r).toEqual({
      total: 5,
      pendentes: 0,
      aceitas: 4,
      entregues: 3,
      lidas: 1,
      respostas: 1,
      saidas: 1,
      falhas: 2,
      falhas_por_codigo: { "131026": 1, "131049": 1 },
    });

    // Outra organização não enxerga nada desta campanha.
    const { rows: alheio } = await pool.query<{ r: { total: number } }>(
      "select public.fn_resultado_da_campanha('00000000-0000-4000-8000-000000000000', $1) as r",
      [id],
    );
    expect(alheio[0]!.r.total).toBe(0);
  });
});
